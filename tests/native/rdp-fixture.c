/* Local-only TLS RDP fixture: synthetic pixels and input acknowledgements.
 * Never shipped in the app; accepts one connection on 127.0.0.1 only. */
#include <freerdp/freerdp.h>
#include <freerdp/peer.h>
#include <freerdp/update.h>
#include <freerdp/input.h>
#include <freerdp/crypto/certificate.h>
#include <freerdp/crypto/privatekey.h>
#include <winpr/synch.h>
#include <winpr/wlog.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
static BOOL connected(freerdp_peer* peer) { (void)peer;return TRUE; }
static BOOL activated(freerdp_peer* peer) {
  BYTE pixels[16*16*4];for(size_t n=0;n<sizeof(pixels);n+=4){pixels[n]=30;pixels[n+1]=120;pixels[n+2]=220;pixels[n+3]=0;}
  BITMAP_DATA data={0};data.destRight=15;data.destBottom=15;data.width=16;data.height=16;data.bitsPerPixel=32;data.bitmapLength=sizeof(pixels);data.bitmapDataStream=pixels;
  BITMAP_UPDATE update={0};update.number=1;update.rectangles=&data;update.skipCompression=TRUE;
  BOOL ok=peer->context->update->BitmapUpdate(peer->context,&update);fprintf(stdout,"FRAME %d\n",ok);fflush(stdout);return ok;
}
static BOOL keyboard(rdpInput* in,UINT16 flags,UINT8 code) { (void)in;(void)flags;(void)code;puts("KEY");fflush(stdout);return TRUE; }
static BOOL pointer(rdpInput* in,UINT16 flags,UINT16 x,UINT16 y) { (void)in;(void)flags;(void)x;(void)y;puts("MOUSE");fflush(stdout);return TRUE; }
int main(int argc,char** argv) {
  if(argc!=3&&argc!=4)return 2;WLog_SetLogLevel(WLog_GetRoot(),WLOG_WARN);WLog_SetLogAppenderType(WLog_GetRoot(),WLOG_APPENDER_CONSOLE);WLog_ConfigureAppender(WLog_GetLogAppender(WLog_GetRoot()),"outputstream","stderr");
  int listener=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in addr={0};addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);addr.sin_port=0;
  if(bind(listener,(struct sockaddr*)&addr,sizeof(addr))||listen(listener,1))return 3;socklen_t size=sizeof(addr);getsockname(listener,(struct sockaddr*)&addr,&size);printf("PORT %u\n",ntohs(addr.sin_port));fflush(stdout);
  int socket=accept(listener,NULL,NULL);close(listener);freerdp_peer* peer=freerdp_peer_new(socket);if(!peer||!freerdp_peer_context_new(peer))return 4;
  rdpSettings* s=peer->context->settings;
  rdpPrivateKey* key=freerdp_key_new_from_file(argv[2]);rdpCertificate* cert=freerdp_certificate_new_from_file(argv[1]);if(!key||!cert)return 5;
  if(!freerdp_settings_set_pointer_len(s,FreeRDP_RdpServerRsaKey,key,1)||!freerdp_settings_set_pointer_len(s,FreeRDP_RdpServerCertificate,cert,1))return 6;
  if(!freerdp_settings_set_bool(s,FreeRDP_NlaSecurity,FALSE)||!freerdp_settings_set_bool(s,FreeRDP_TlsSecurity,TRUE)||!freerdp_settings_set_bool(s,FreeRDP_RdpSecurity,FALSE)||!freerdp_settings_set_bool(s,FreeRDP_ExtSecurity,FALSE)||!freerdp_settings_set_bool(s,FreeRDP_RemoteFxCodec,FALSE)||!freerdp_settings_set_bool(s,FreeRDP_NSCodec,FALSE)||!freerdp_settings_set_uint32(s,FreeRDP_ColorDepth,32)||!freerdp_settings_set_uint32(s,FreeRDP_DesktopWidth,320)||!freerdp_settings_set_uint32(s,FreeRDP_DesktopHeight,200))return 7;
  if(argc==4&&(!freerdp_settings_set_bool(s,FreeRDP_NlaSecurity,TRUE)||!freerdp_settings_set_string(s,FreeRDP_NtlmSamFile,argv[3])))return 9;
  peer->PostConnect=connected;peer->Activate=activated;peer->context->input->KeyboardEvent=keyboard;peer->context->input->MouseEvent=pointer;
  if(!peer->Initialize(peer))return 8;
  for(int n=0;n<3000;n++){HANDLE handles[64];DWORD count=peer->GetEventHandles(peer,handles,64);if(!count)break;DWORD status=WaitForMultipleObjects(count,handles,FALSE,10);if(status==WAIT_FAILED)break;if(status!=WAIT_TIMEOUT&&!peer->CheckFileDescriptor(peer))break;}
  peer->Disconnect(peer);freerdp_peer_context_free(peer);freerdp_peer_free(peer);return 0;
}
