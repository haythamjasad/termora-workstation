// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TermoraNative",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "TermoraNative", targets: ["TermoraNative"])],
    dependencies: [.package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.10.1")],
    targets: [
        .target(name: "TermoraCore"),
        .executableTarget(name: "TermoraNative", dependencies: ["TermoraCore", .product(name: "SwiftTerm", package: "SwiftTerm")]),
        .testTarget(name: "TermoraCoreTests", dependencies: ["TermoraCore"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageVersions: [.v5]
)
