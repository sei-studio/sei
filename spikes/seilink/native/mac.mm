// SeiLink spike: macOS window level / collection behavior + CGWindowList dump.
// Technical spike only. See spikes/seilink/README.md.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <napi.h>

#include <string>

namespace {

NSWindow* WindowFrom(const Napi::Value& v) {
  if (!v.IsBuffer()) return nil;
  auto b = v.As<Napi::Buffer<uint8_t>>();
  if (b.Length() < sizeof(void*)) return nil;
  void* p = nullptr;
  memcpy(&p, b.Data(), sizeof(p));
  NSView* view = (__bridge NSView*)p;  // getNativeWindowHandle() = NSView*
  return [view window];
}

Napi::Object WinObj(Napi::Env env, NSWindow* w) {
  auto o = Napi::Object::New(env);
  if (!w) {
    o.Set("valid", false);
    return o;
  }
  o.Set("valid", true);
  o.Set("windowNumber", (double)[w windowNumber]);
  o.Set("level", (double)[w level]);
  o.Set("collectionBehavior", (double)[w collectionBehavior]);
  o.Set("ignoresMouseEvents", (bool)[w ignoresMouseEvents]);
  o.Set("isVisible", (bool)[w isVisible]);
  o.Set("occlusionVisible", (bool)(([w occlusionState] & NSWindowOcclusionStateVisible) != 0));
  o.Set("canBecomeKey", (bool)[w canBecomeKeyWindow]);
  o.Set("isKey", (bool)[w isKeyWindow]);
  o.Set("className", std::string([NSStringFromClass([w class]) UTF8String]));
  o.Set("styleMask", (double)[w styleMask]);
  NSRect f = [w frame];
  auto r = Napi::Object::New(env);
  r.Set("x", f.origin.x);
  r.Set("y", f.origin.y);
  r.Set("w", f.size.width);
  r.Set("h", f.size.height);
  o.Set("frame", r);
  return o;
}

Napi::Value Levels(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto o = Napi::Object::New(env);
  o.Set("minimum", (double)CGWindowLevelForKey(kCGMinimumWindowLevelKey));
  o.Set("desktop", (double)CGWindowLevelForKey(kCGDesktopWindowLevelKey));
  o.Set("backstopMenu", (double)CGWindowLevelForKey(kCGBackstopMenuLevelKey));
  o.Set("desktopIcon", (double)CGWindowLevelForKey(kCGDesktopIconWindowLevelKey));
  o.Set("normal", (double)CGWindowLevelForKey(kCGNormalWindowLevelKey));
  o.Set("floating", (double)CGWindowLevelForKey(kCGFloatingWindowLevelKey));
  NSOperatingSystemVersion v = [[NSProcessInfo processInfo] operatingSystemVersion];
  o.Set("os", std::to_string(v.majorVersion) + "." + std::to_string(v.minorVersion) + "." +
                  std::to_string(v.patchVersion));
  o.Set("axTrusted", (bool)AXIsProcessTrusted());
  if (@available(macOS 10.15, *)) o.Set("screenCaptureAccess", (bool)CGPreflightScreenCaptureAccess());
  return o;
}

// setLevel(handle, {level, behavior: number, ignoresMouse: bool})
Napi::Value SetLevel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSWindow* w = WindowFrom(info[0]);
  auto out = Napi::Object::New(env);
  if (!w) {
    out.Set("ok", false);
    return out;
  }
  out.Set("before", WinObj(env, w));
  auto opts = info[1].As<Napi::Object>();
  if (opts.Has("level")) [w setLevel:(NSWindowLevel)opts.Get("level").As<Napi::Number>().Int64Value()];
  if (opts.Has("behavior"))
    [w setCollectionBehavior:(NSWindowCollectionBehavior)opts.Get("behavior").As<Napi::Number>().Int64Value()];
  if (opts.Has("ignoresMouse")) [w setIgnoresMouseEvents:opts.Get("ignoresMouse").ToBoolean().Value()];
  out.Set("after", WinObj(env, w));
  out.Set("ok", true);
  return out;
}

Napi::Value WindowInfo(const Napi::CallbackInfo& info) {
  return WinObj(info.Env(), WindowFrom(info[0]));
}

Napi::Value Behaviors(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto o = Napi::Object::New(env);
  o.Set("canJoinAllSpaces", (double)NSWindowCollectionBehaviorCanJoinAllSpaces);
  o.Set("stationary", (double)NSWindowCollectionBehaviorStationary);
  o.Set("ignoresCycle", (double)NSWindowCollectionBehaviorIgnoresCycle);
  o.Set("fullScreenAuxiliary", (double)NSWindowCollectionBehaviorFullScreenAuxiliary);
  return o;
}

std::string Str(CFStringRef s) {
  if (!s) return "";
  char buf[512];
  if (CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8)) return buf;
  return "";
}

// CGWindowList dump (on-screen only unless all=true). Names need Screen Recording; owners/levels do not.
Napi::Value WindowList(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool all = info.Length() > 0 && info[0].ToBoolean().Value();
  CFArrayRef list = CGWindowListCopyWindowInfo(
      all ? kCGWindowListOptionAll : (kCGWindowListOptionOnScreenOnly), kCGNullWindowID);
  auto arr = Napi::Array::New(env);
  if (!list) return arr;
  CFIndex n = CFArrayGetCount(list);
  uint32_t k = 0;
  for (CFIndex i = 0; i < n; i++) {
    CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
    auto o = Napi::Object::New(env);
    int64_t num = 0, layer = 0, pid = 0;
    CFNumberRef nr;
    if ((nr = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowNumber))) CFNumberGetValue(nr, kCFNumberSInt64Type, &num);
    if ((nr = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowLayer))) CFNumberGetValue(nr, kCFNumberSInt64Type, &layer);
    if ((nr = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowOwnerPID))) CFNumberGetValue(nr, kCFNumberSInt64Type, &pid);
    double alpha = 0;
    if ((nr = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowAlpha))) CFNumberGetValue(nr, kCFNumberDoubleType, &alpha);
    CGRect b = CGRectZero;
    CFDictionaryRef bd = (CFDictionaryRef)CFDictionaryGetValue(d, kCGWindowBounds);
    if (bd) CGRectMakeWithDictionaryRepresentation(bd, &b);
    CFBooleanRef on = (CFBooleanRef)CFDictionaryGetValue(d, kCGWindowIsOnscreen);
    o.Set("z", (double)i);  // CGWindowList is front-to-back
    o.Set("number", (double)num);
    o.Set("layer", (double)layer);
    o.Set("pid", (double)pid);
    o.Set("owner", Str((CFStringRef)CFDictionaryGetValue(d, kCGWindowOwnerName)));
    o.Set("name", Str((CFStringRef)CFDictionaryGetValue(d, kCGWindowName)));
    o.Set("alpha", alpha);
    o.Set("onscreen", on ? (bool)CFBooleanGetValue(on) : false);
    auto r = Napi::Object::New(env);
    r.Set("x", b.origin.x);
    r.Set("y", b.origin.y);
    r.Set("w", b.size.width);
    r.Set("h", b.size.height);
    o.Set("bounds", r);
    arr.Set(k++, o);
  }
  CFRelease(list);
  return arr;
}

// TEST HARNESS ONLY: stand-in for a real hand. Posts an OS-level click via CGEventPost.
// Requires Accessibility trust for the responsible process; result is reported, not assumed.
Napi::Value TestClick(const Napi::CallbackInfo& info) {
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();  // global display coords, top-left origin
  CGPoint p = CGPointMake(x, y);
  CGEventRef mv = CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  CGEventRef dn = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseDown, p, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseUp, p, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, mv);
  usleep(50000);
  CGEventPost(kCGHIDEventTap, dn);
  usleep(50000);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(mv);
  CFRelease(dn);
  CFRelease(up);
  return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

Napi::Value Frontmost(const Napi::CallbackInfo& info) {
  NSRunningApplication* a = [[NSWorkspace sharedWorkspace] frontmostApplication];
  std::string s = a ? std::string([[a localizedName] UTF8String] ?: "") : "";
  return Napi::String::New(info.Env(), s);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platform", "darwin");
  exports.Set("levels", Napi::Function::New(env, Levels));
  exports.Set("behaviors", Napi::Function::New(env, Behaviors));
  exports.Set("setLevel", Napi::Function::New(env, SetLevel));
  exports.Set("windowInfo", Napi::Function::New(env, WindowInfo));
  exports.Set("windowList", Napi::Function::New(env, WindowList));
  exports.Set("testClick", Napi::Function::New(env, TestClick));
  exports.Set("frontmost", Napi::Function::New(env, Frontmost));
  return exports;
}

}  // namespace

NODE_API_MODULE(seilink, Init)
