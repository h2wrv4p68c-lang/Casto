// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "CastoBrowser",
  platforms: [.macOS(.v12)],
  targets: [
    .executableTarget(name: "CastoBrowser", path: "Sources/CastoBrowser")
  ]
)
