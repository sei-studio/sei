{
  "target_defaults": {
    "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
    "conditions": [
      ["OS=='win'", {
        "defines": ["UNICODE", "_UNICODE"],
        "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++20"] } }
      }],
      ["OS=='mac'", {
        "xcode_settings": {
          "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
          "CLANG_ENABLE_OBJC_ARC": "YES",
          "MACOSX_DEPLOYMENT_TARGET": "12.0",
          "OTHER_CPLUSPLUSFLAGS": ["-std=c++20", "-fobjc-arc"]
        }
      }]
    ]
  },
  "targets": [
    {
      "target_name": "seilink",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/win.cc"],
          "libraries": ["user32.lib", "dwmapi.lib", "wtsapi32.lib", "shell32.lib"]
        }],
        ["OS=='mac'", {
          "sources": ["src/mac.mm"],
          "link_settings": { "libraries": ["-framework AppKit", "-framework CoreGraphics"] }
        }]
      ]
    },
    {
      "target_name": "seilink_test",
      "conditions": [
        ["OS=='win'", { "sources": ["ci/test_win.cc"], "libraries": ["user32.lib"] }],
        ["OS=='mac'", {
          "sources": ["ci/test_mac.mm"],
          "link_settings": { "libraries": ["-framework AppKit", "-framework ApplicationServices"] }
        }]
      ]
    }
  ]
}
