// SeiLink spike: Linux stub so the module loads for local logic checks. No desktop layer here.
#include <napi.h>

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platform", "linux-stub");
  return exports;
}

NODE_API_MODULE(seilink, Init)
