/* Termora's windowless FreeRDP display bridge. MIT, like the host application.
 * Uses FreeRDP's public client/GDI API; no SDL application or native UI.
 * stdout: bounded binary messages. stdin: credentials, input, trust decisions.
 */
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/channels.h>
#include <freerdp/channels/channels.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/input.h>
#include <freerdp/client/cliprdr.h>
#include <winpr/clipboard.h>
#include <winpr/string.h>
#include <pthread.h>
#include <freerdp/scancode.h>
#include <winpr/crt.h>
#include <winpr/synch.h>
#include <winpr/wlog.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <time.h>
#include <stdint.h>

#define MAX_PIXELS (16U * 1024U * 1024U)
#define BRIDGE_MAX_INPUT (1024U * 1024U)
typedef struct {
  rdpClientContext common;
  char* credentials[6];
  BOOL attempted[16];
  BOOL dirty;
  int left,top,right,bottom;
  uint64_t painted;
  BYTE buttons;
  CliprdrClientContext* clip;
  char* clipboard;
  BOOL paste_pending;
  BOOL clipboard_inflight;
  BOOL clipboard_queued;
  pthread_mutex_t clipboard_lock;
} Bridge;
static uint32_t u32(const BYTE* p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
static void put32(BYTE* p,uint32_t v) { p[0]=v>>24;p[1]=v>>16;p[2]=v>>8;p[3]=v; }
static BOOL read_all(void* p,size_t n) { BYTE* b=p;while(n){ssize_t r=read(0,b,n);if(r<=0)return FALSE;b+=r;n-=r;}return TRUE; }
static BOOL write_all(const void* p,size_t n) { const BYTE* b=p;while(n){ssize_t r=write(1,b,n);if(r<=0)return FALSE;b+=r;n-=r;}return TRUE; }
static BOOL message(BYTE type,const void* data,uint32_t size) { BYTE h[5]={type};put32(h+1,size);return write_all(h,5)&&(!size||write_all(data,size)); }
static BOOL command(BYTE* type,BYTE** data,uint32_t* size) {
  BYTE h[5];if(!read_all(h,5))return FALSE;*type=h[0];*size=u32(h+1);
  if(*size>BRIDGE_MAX_INPUT)return FALSE;*data=calloc(1,(size_t)*size+1);if(!*data)return FALSE;
  if(!read_all(*data,*size)){free(*data);*data=NULL;return FALSE;}return TRUE;
}
static uint64_t millis(void) { struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);return (uint64_t)ts.tv_sec*1000+ts.tv_nsec/1000000; }
static BOOL dimensions(rdpContext* c) {
  const UINT32 w=freerdp_settings_get_uint32(c->settings,FreeRDP_DesktopWidth),h=freerdp_settings_get_uint32(c->settings,FreeRDP_DesktopHeight);
  if(!w||!h||w>8192||h>8192||(uint64_t)w*h>MAX_PIXELS)return FALSE;
  BYTE p[8];put32(p,w);put32(p+4,h);return message('R',p,8);
}
static BOOL begin_paint(rdpContext* c) { c->gdi->primary->hdc->hwnd->invalid->null=TRUE;return TRUE; }
static void full_frame(rdpContext* c) { Bridge* b=(Bridge*)c;b->dirty=TRUE;b->left=0;b->top=0;b->right=c->gdi->width;b->bottom=c->gdi->height; }
static BOOL end_paint(rdpContext* c) {
  Bridge* b=(Bridge*)c;HGDI_RGN invalid=c->gdi->primary->hdc->hwnd->invalid;if(invalid->null)return TRUE;
  int left=invalid->x<0?0:invalid->x,top=invalid->y<0?0:invalid->y;int64_t right=(int64_t)invalid->x+invalid->w,bottom=(int64_t)invalid->y+invalid->h;
  if(right>c->gdi->width)right=c->gdi->width;if(bottom>c->gdi->height)bottom=c->gdi->height;if(right<=left||bottom<=top)return TRUE;
  if(b->dirty){if(left<b->left)b->left=left;if(top<b->top)b->top=top;if(right>b->right)b->right=(int)right;if(bottom>b->bottom)b->bottom=(int)bottom;}else{b->left=left;b->top=top;b->right=(int)right;b->bottom=(int)bottom;}
  b->dirty=TRUE;return TRUE;
}
static BOOL flush_frame(rdpContext* c) {
  Bridge* b=(Bridge*)c;rdpGdi* g=c->gdi;if(!g||!b->dirty||millis()-b->painted<40)return TRUE;
  if(g->width<=0||g->height<=0||(uint64_t)g->width*g->height>MAX_PIXELS)return FALSE;
  int width=b->right-b->left,height=b->bottom-b->top;if(width<=0||height<=0)return TRUE;BYTE header[5]={'F'},rect[16]={0};put32(header+1,16+(uint32_t)width*height*4);put32(rect,b->left);put32(rect+4,b->top);put32(rect+8,width);put32(rect+12,height);
  if(!write_all(header,5)||!write_all(rect,16))return FALSE;
  for(int y=0;y<height;y++)if(!write_all(g->primary_buffer+(size_t)(b->top+y)*g->stride+(size_t)b->left*4,(size_t)width*4))return FALSE;
  b->dirty=FALSE;b->painted=millis();return TRUE;
}
static BOOL resize(rdpContext* c) { if(!dimensions(c)||!gdi_resize(c->gdi,freerdp_settings_get_uint32(c->settings,FreeRDP_DesktopWidth),freerdp_settings_get_uint32(c->settings,FreeRDP_DesktopHeight)))return FALSE;full_frame(c);return TRUE; }
/* One-way paste only. No local clipboard monitoring and no server clipboard
 * data requests or data-response callbacks. The only text served is command T
 * supplied by an explicit Paste action in the selected Termora tab. */
static UINT clipboard_announce(Bridge* b) {
  if(!b->clip)return CHANNEL_RC_OK;CLIPRDR_FORMAT format={CF_UNICODETEXT,NULL};CLIPRDR_FORMAT_LIST list={0};pthread_mutex_lock(&b->clipboard_lock);if(b->clipboard_inflight){b->clipboard_queued=TRUE;pthread_mutex_unlock(&b->clipboard_lock);return CHANNEL_RC_OK;}b->clipboard_inflight=TRUE;list.numFormats=b->clipboard?1:0;pthread_mutex_unlock(&b->clipboard_lock);list.formats=&format;return b->clip->ClientFormatList(b->clip,&list);
}
static UINT clipboard_ready(CliprdrClientContext* clip,const CLIPRDR_MONITOR_READY* ready) {
  (void)ready;CLIPRDR_GENERAL_CAPABILITY_SET general={CB_CAPSTYPE_GENERAL,12,CB_CAPS_VERSION_2,CB_USE_LONG_FORMAT_NAMES};CLIPRDR_CAPABILITIES caps={0};caps.cCapabilitiesSets=1;caps.capabilitySets=(CLIPRDR_CAPABILITY_SET*)&general;UINT rc=clip->ClientCapabilities(clip,&caps);return rc==CHANNEL_RC_OK?clipboard_announce((Bridge*)clip->custom):rc;
}
static UINT clipboard_formats(CliprdrClientContext* clip,const CLIPRDR_FORMAT_LIST* list) {
  (void)list;CLIPRDR_FORMAT_LIST_RESPONSE response={0};response.common.msgFlags=CB_RESPONSE_OK;return clip->ClientFormatListResponse(clip,&response);
}
static UINT clipboard_ack(CliprdrClientContext* clip,const CLIPRDR_FORMAT_LIST_RESPONSE* response) {
  Bridge* b=clip->custom;pthread_mutex_lock(&b->clipboard_lock);b->clipboard_inflight=FALSE;BOOL queued=b->clipboard_queued;b->clipboard_queued=FALSE;BOOL paste=!queued&&b->paste_pending&&(response->common.msgFlags&CB_RESPONSE_OK);if(!queued)b->paste_pending=FALSE;pthread_mutex_unlock(&b->clipboard_lock);if(queued)return clipboard_announce(b);
  if(paste){rdpInput* in=b->common.context.input;if(!freerdp_input_send_keyboard_event_ex(in,TRUE,FALSE,RDP_SCANCODE_LCONTROL)||!freerdp_input_send_keyboard_event_ex(in,TRUE,FALSE,0x2f)||!freerdp_input_send_keyboard_event_ex(in,FALSE,FALSE,0x2f)||!freerdp_input_send_keyboard_event_ex(in,FALSE,FALSE,RDP_SCANCODE_LCONTROL))return ERROR_INTERNAL_ERROR;}
  return CHANNEL_RC_OK;
}
static UINT clipboard_request(CliprdrClientContext* clip,const CLIPRDR_FORMAT_DATA_REQUEST* request) {
  Bridge* b=clip->custom;CLIPRDR_FORMAT_DATA_RESPONSE response={0};WCHAR* wide=NULL;int count=0;
  pthread_mutex_lock(&b->clipboard_lock);if(request->requestedFormatId==CF_UNICODETEXT&&b->clipboard){size_t chars=0;wide=ConvertUtf8ToWCharAlloc(b->clipboard,&chars);if(wide&&chars<BRIDGE_MAX_INPUT/2)count=(int)chars+1;else{free(wide);wide=NULL;}}pthread_mutex_unlock(&b->clipboard_lock);
  response.common.msgFlags=wide?CB_RESPONSE_OK:CB_RESPONSE_FAIL;response.common.dataLen=wide?count*sizeof(WCHAR):0;response.requestedFormatData=(BYTE*)wide;UINT rc=clip->ClientFormatDataResponse(clip,&response);if(wide){SecureZeroMemory(wide,count*sizeof(WCHAR));free(wide);}return rc;
}
static void channel_connected(void* context,const ChannelConnectedEventArgs* e) {
  Bridge* b=context;if(!strcmp(e->name,CLIPRDR_SVC_CHANNEL_NAME)){b->clip=e->pInterface;b->clip->custom=b;b->clip->MonitorReady=clipboard_ready;b->clip->ServerFormatList=clipboard_formats;b->clip->ServerFormatDataRequest=clipboard_request;b->clip->ServerFormatDataResponse=NULL;b->clip->ServerFormatListResponse=clipboard_ack;}else freerdp_client_OnChannelConnectedEventHandler(context,e);
}
static void channel_disconnected(void* context,const ChannelDisconnectedEventArgs* e) { Bridge* b=context;if(!strcmp(e->name,CLIPRDR_SVC_CHANNEL_NAME)){if(b->clip)b->clip->custom=NULL;b->clip=NULL;}else freerdp_client_OnChannelDisconnectedEventHandler(context,e); }
static BOOL pre_connect(freerdp* instance) {
  rdpContext* c=instance->context;
  if(PubSub_SubscribeChannelConnected(c->pubSub,channel_connected)<0||PubSub_SubscribeChannelDisconnected(c->pubSub,channel_disconnected)<0)return FALSE;
  return freerdp_client_load_channels(instance);
}
static BOOL post_connect(freerdp* instance) {
  if(!gdi_init(instance,PIXEL_FORMAT_BGRX32))return FALSE;
  rdpContext* c=instance->context;c->update->BeginPaint=begin_paint;c->update->EndPaint=end_paint;c->update->DesktopResize=resize;
  full_frame(c);return dimensions(c);
}
static void post_disconnect(freerdp* instance) {
  rdpContext* c=instance->context;PubSub_UnsubscribeChannelConnected(c->pubSub,channel_connected);PubSub_UnsubscribeChannelDisconnected(c->pubSub,channel_disconnected);gdi_free(instance);
}
static BOOL authenticate(freerdp* instance,char** user,char** password,char** domain,rdp_auth_reason reason) {
  Bridge* b=(Bridge*)instance->context;int gateway=reason==GW_AUTH_HTTP||reason==GW_AUTH_RDG||reason==GW_AUTH_RPC;int offset=gateway&&b->credentials[3]&&*b->credentials[3]?3:0;
  if(((unsigned)reason>=16)||b->attempted[reason]||!b->credentials[offset]||!*b->credentials[offset]||!b->credentials[offset+2]||!*b->credentials[offset+2])return FALSE;
  b->attempted[reason]=TRUE;free(*user);free(*domain);free(*password);
  *user=_strdup(b->credentials[offset]);*domain=_strdup(b->credentials[offset+1]);*password=_strdup(b->credentials[offset+2]);return *user&&*domain&&*password;
}
static DWORD certificate(freerdp* i,const char* host,UINT16 port,const char* name,const char* subject,const char* issuer,const char* fingerprint,DWORD flags) {
  (void)i;(void)flags;const char* values[]={host,name,subject,issuer,fingerprint};size_t size=2;
  for(size_t n=0;n<5;n++){size_t len=values[n]?strlen(values[n]):0;if(len>16384)return 0;size+=4+len;}
  BYTE* data=malloc(size);if(!data)return 0;BYTE* p=data;*p++=port>>8;*p++=port;
  for(size_t n=0;n<5;n++){size_t len=values[n]?strlen(values[n]):0;put32(p,len);p+=4;if(len)memcpy(p,values[n],len);p+=len;}
  BOOL sent=message('C',data,size);free(data);if(!sent)return 0;
  BYTE type,*response=NULL;uint32_t len=0;if(!command(&type,&response,&len))return 0;
  DWORD result=type=='V'&&len==1&&response[0]==1?2:0;free(response);return result;
}
static DWORD changed_certificate(freerdp* i,const char* host,UINT16 port,const char* name,const char* subject,const char* issuer,const char* fingerprint,const char* old_subject,const char* old_issuer,const char* old_fingerprint,DWORD flags) {
  (void)old_subject;(void)old_issuer;(void)old_fingerprint;return certificate(i,host,port,name,subject,issuer,fingerprint,flags);
}
static BOOL client_new(freerdp* instance,rdpContext* context) {
  pthread_mutex_init(&((Bridge*)context)->clipboard_lock,NULL);instance->PreConnect=pre_connect;instance->PostConnect=post_connect;instance->PostDisconnect=post_disconnect;instance->AuthenticateEx=authenticate;instance->VerifyCertificateEx=certificate;instance->VerifyChangedCertificateEx=changed_certificate;return TRUE;
}
static BOOL credentials(Bridge* b) {
  BYTE type,*data=NULL;uint32_t size=0;if(!command(&type,&data,&size))return FALSE;
  BOOL ok=type=='S';size_t offset=0;
  for(size_t n=0;ok&&n<6;n++){if(offset+4>size){ok=FALSE;break;}uint32_t len=u32(data+offset);offset+=4;if(len>4096||offset+len>size){ok=FALSE;break;}b->credentials[n]=calloc(1,(size_t)len+1);if(!b->credentials[n]){ok=FALSE;break;}memcpy(b->credentials[n],data+offset,len);offset+=len;}
  if(offset!=size)ok=FALSE;SecureZeroMemory(data,size);free(data);return ok;
}
static DWORD keyscan(UINT32 k) {
  static const char letters[]="abcdefghijklmnopqrstuvwxyz";static const BYTE scans[]={0x1e,0x30,0x2e,0x20,0x12,0x21,0x22,0x23,0x17,0x24,0x25,0x26,0x32,0x31,0x18,0x19,0x10,0x13,0x1f,0x14,0x16,0x2f,0x11,0x2d,0x15,0x2c};
  if(k>='A'&&k<='Z')k+=32;if(k>='a'&&k<='z')return scans[k-'a'];
  (void)letters;if(k>='1'&&k<='9')return 2+k-'1';if(k=='0')return 0x0b;
  switch(k){case 0xff08:return RDP_SCANCODE_BACKSPACE;case 0xff09:return RDP_SCANCODE_TAB;case 0xff0d:return RDP_SCANCODE_RETURN;case 0xff1b:return RDP_SCANCODE_ESCAPE;case 0xffff:return RDP_SCANCODE_DELETE;case 0xff50:return RDP_SCANCODE_HOME;case 0xff57:return RDP_SCANCODE_END;case 0xff51:return RDP_SCANCODE_LEFT;case 0xff52:return RDP_SCANCODE_UP;case 0xff53:return RDP_SCANCODE_RIGHT;case 0xff54:return RDP_SCANCODE_DOWN;case 0xff55:return RDP_SCANCODE_PRIOR;case 0xff56:return RDP_SCANCODE_NEXT;case 0xff63:return RDP_SCANCODE_INSERT;case 0xffe1:return RDP_SCANCODE_LSHIFT;case 0xffe2:return RDP_SCANCODE_RSHIFT;case 0xffe3:return RDP_SCANCODE_LCONTROL;case 0xffe4:return RDP_SCANCODE_RCONTROL;case 0xffe9:return RDP_SCANCODE_LMENU;case 0xffea:return RDP_SCANCODE_RMENU;case 0xffeb:return RDP_SCANCODE_LWIN;case 0xffec:return RDP_SCANCODE_RWIN;case 0xffe5:return RDP_SCANCODE_CAPSLOCK;case ' ':return RDP_SCANCODE_SPACE;default:if(k>=0xffbe&&k<=0xffc9)return k<0xffc8?RDP_SCANCODE_F1+(k-0xffbe):RDP_SCANCODE_F11+(k-0xffc8);return 0;}
}
static BOOL input(freerdp* instance,BYTE type,const BYTE* p,uint32_t size) {
  rdpInput* in=instance->context->input;Bridge* b=(Bridge*)instance->context;
  if(type=='K'&&size==5){BOOL down=p[0];UINT32 k=u32(p+1);DWORD scan=keyscan(k);if(scan)return freerdp_input_send_keyboard_event_ex(in,down,FALSE,scan);k=k>=0x01000000?k&0x00ffffff:k;if(k>0x10ffff)return FALSE;UINT16 flags=down?0:KBD_FLAGS_RELEASE;if(k>0xffff){k-=0x10000;return freerdp_input_send_unicode_keyboard_event(in,flags,0xd800+(k>>10))&&freerdp_input_send_unicode_keyboard_event(in,flags,0xdc00+(k&1023));}return freerdp_input_send_unicode_keyboard_event(in,flags,k);}
  if(type=='M'&&size==5){BYTE mask=p[0];UINT16 x=((UINT16)p[1]<<8)|p[2],y=((UINT16)p[3]<<8)|p[4];if(x>=instance->context->gdi->width||y>=instance->context->gdi->height)return TRUE;BOOL ok=freerdp_input_send_mouse_event(in,PTR_FLAGS_MOVE,x,y);const UINT16 buttons[]={PTR_FLAGS_BUTTON1,PTR_FLAGS_BUTTON3,PTR_FLAGS_BUTTON2};for(int n=0;n<3;n++)if((mask^b->buttons)&(1<<n))ok=ok&&freerdp_input_send_mouse_event(in,buttons[n]|((mask&(1<<n))?PTR_FLAGS_DOWN:0),x,y);if((mask&8)&&!(b->buttons&8))ok=ok&&freerdp_input_send_mouse_event(in,PTR_FLAGS_WHEEL|120,x,y);if((mask&16)&&!(b->buttons&16))ok=ok&&freerdp_input_send_mouse_event(in,PTR_FLAGS_WHEEL|PTR_FLAGS_WHEEL_NEGATIVE|136,x,y);b->buttons=mask;return ok;}
  if(type=='T'&&size<=BRIDGE_MAX_INPUT){pthread_mutex_lock(&b->clipboard_lock);if(b->clipboard){SecureZeroMemory(b->clipboard,strlen(b->clipboard));free(b->clipboard);}b->clipboard=calloc(1,(size_t)size+1);if(b->clipboard)memcpy(b->clipboard,p,size);b->paste_pending=TRUE;pthread_mutex_unlock(&b->clipboard_lock);return clipboard_announce(b)==CHANNEL_RC_OK;}
  if(type=='Q'&&size==0)return FALSE;
  return TRUE;
}
static int fixture(void) {
  BYTE ready[8];put32(ready,64);put32(ready+4,32);message('R',ready,8);
  BYTE pixels[16+64*32*4]={0};put32(pixels+8,64);put32(pixels+12,32);for(size_t n=16;n<sizeof(pixels);n+=4){pixels[n]=30;pixels[n+1]=120;pixels[n+2]=220;}
  message('F',pixels,sizeof(pixels));BYTE type,*data=NULL;uint32_t size;
  while(command(&type,&data,&size)){if(type=='Q'){free(data);break;}message('A',data,size);free(data);}return 0;
}
int main(int argc,char** argv) {
  signal(SIGPIPE,SIG_DFL);
  if(argc==2&&!strcmp(argv[1],"/version")){fprintf(stderr,"Termora embedded FreeRDP bridge %s\n",freerdp_get_version_string());return 0;}
  if(argc==2&&!strcmp(argv[1],"--self-test"))return fixture();
  if(argc!=2)return 2;
  WLog_SetLogLevel(WLog_GetRoot(),WLOG_WARN);WLog_SetLogAppenderType(WLog_GetRoot(),WLOG_APPENDER_CONSOLE);WLog_ConfigureAppender(WLog_GetLogAppender(WLog_GetRoot()),"outputstream","stderr");
  RDP_CLIENT_ENTRY_POINTS ep={0};ep.Size=sizeof(ep);ep.Version=RDP_CLIENT_INTERFACE_VERSION;ep.ContextSize=sizeof(Bridge);ep.ClientNew=client_new;
  rdpContext* c=freerdp_client_context_new(&ep);if(!c)return 3;freerdp* instance=c->instance;Bridge* b=(Bridge*)c;BOOL ok=credentials(b);
  if(ok)ok=freerdp_client_settings_parse_command_line(c->settings,argc,argv,FALSE)>=0;
  if(ok)ok=freerdp_settings_set_bool(c->settings,FreeRDP_CertificateCallbackPreferPEM,FALSE)&&freerdp_settings_set_bool(c->settings,FreeRDP_SoftwareGdi,TRUE)&&freerdp_settings_set_bool(c->settings,FreeRDP_SupportGraphicsPipeline,TRUE);
  if(ok)ok=freerdp_connect(instance);
  while(ok&&!freerdp_shall_disconnect_context(c)){
    HANDLE handles[64];DWORD count=freerdp_get_event_handles(c,handles,64);if(!count)break;DWORD status=WaitForMultipleObjects(count,handles,FALSE,10);if(status==WAIT_FAILED)break;
    if(status!=WAIT_TIMEOUT&&!freerdp_check_event_handles(c))break;
    struct pollfd descriptor={0,POLLIN,0};if(poll(&descriptor,1,0)>0){BYTE type,*data=NULL;uint32_t size=0;if(!command(&type,&data,&size))break;ok=input(instance,type,data,size);SecureZeroMemory(data,size);free(data);}
    if(!flush_frame(c))break;
  }
  UINT32 error=freerdp_get_last_error(c);if(error){const char* name=freerdp_get_last_error_name(error);message('E',name,strlen(name));}
  freerdp_disconnect(instance);for(size_t n=0;n<6;n++){if(b->credentials[n]){SecureZeroMemory(b->credentials[n],strlen(b->credentials[n]));free(b->credentials[n]);}}
  if(b->clipboard){SecureZeroMemory(b->clipboard,strlen(b->clipboard));free(b->clipboard);}pthread_mutex_destroy(&b->clipboard_lock);freerdp_client_context_free(c);return error?1:0;
}
