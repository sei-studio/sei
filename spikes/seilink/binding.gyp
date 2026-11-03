{
  "targets": [
    {
      "target_name": "seilink",
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["native/win.cc"],
          "libraries": ["user32.lib", "dwmapi.lib", "advapi32.lib", "wtsapi32.lib", "shell32.lib"],
          "defines": ["UNICODE", "_UNICODE"],
          "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++20"] } }
        }],
        ["OS=='mac'", {
          "sources": ["native/mac.mm"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++20", "-fobjc-arc"]
          },
          "link_settings": {
            "libraries": ["-framework AppKit", "-framework CoreGraphics", "-framework ApplicationServices"]
          }
        }],
        ["OS=='linux'", { "sources": ["native/stub.cc"], "cflags_cc": ["-std=c++20"] }]
      ]
    }
  ]
}
