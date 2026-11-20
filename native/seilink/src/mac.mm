// SeiLink desktop host, macOS half (261104, milestone 3). Ported from the spike
// (exp/seilink-spike, spikes/seilink/native/mac.mm + mac_r2.inc); the window-list dumps and the
// synthetic-input helpers stayed behind (the latter live in test_mac.mm, never shipped).
//
// Loaded only by the room host process (src/main/seilink/host/hostEntry.ts). Exports:
//
//   setDesktopLevel(handle)   the room window goes to kCGDesktopIconWindowLevel - 1 (below
//                             Finder's icons, above the wallpaper), on every Space, out of the
//                             window cycle, ignoring the mouse. -> {ok, level}
//   onEvents(cb)              cb(json) for hit-layer and occlusion events.
//   hitPanel({x,y,w,h})       create or move the hit layer: a borderless, non-activating NSPanel
//                             at kCGDesktopIconWindowLevel + 1 over HER box only (global top-left
//                             coordinates, points). It never becomes key or main and is not
//                             movable, so a click on her neither activates Sei nor reaches the
//                             wallpaper (where WindowManager's "click wallpaper to reveal desktop"
//                             would sweep every window away). Clicks next to her box are the
//                             desktop's as usual.
//   hitPanelClose()
//                             261110: both take an optional slot (0 = her, 1 = the dock in the
//                             corner of the screen; HIT_PANEL_SLOTS). Slot 1's occlusion is
//                             observed as tag "dock". hitPanelClose() with no slot closes all.
//   observeOcclusion(handle, tag)  NSWindowDidChangeOcclusionStateNotification -> {type:'occlusion'}.
//                             The panel is observed as tag "panel" automatically. Returns the
//                             current visibility.
//   doubleClickMs()           [NSEvent doubleClickInterval] in ms.
//
// Events (JSON strings): {type:'hit', kind:'down'|'click'|'dblclick'|'drag-start'|'drag-move'|
// 'drag-end'|'right-down', x, y, clickCount?} and {type:'occlusion', tag, visible}.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <napi.h>

#include <cmath>
#include <string>

static Napi::ThreadSafeFunction g_macTsfn;
static bool g_macTsfnSet = false;

static void MacEmit(std::string json) {
  if (!g_macTsfnSet) return;
  auto* p = new std::string(std::move(json));
  napi_status st = g_macTsfn.NonBlockingCall(p, [](Napi::Env env, Napi::Function cb, std::string* s) {
    if (env != nullptr && !cb.IsEmpty()) cb.Call({Napi::String::New(env, *s)});
    delete s;
  });
  if (st != napi_ok) delete p;
}

static CGFloat PrimaryH() { return [[NSScreen screens] firstObject].frame.size.height; }

@interface SeiHitPanel : NSPanel
@end
@implementation SeiHitPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface SeiHitView : NSView {
 @public
  NSPoint downPt, lastPt;
  BOOL dragging;
  NSInteger downCount;
  NSTimeInterval lastEmit;
}
@end
@implementation SeiHitView
- (BOOL)acceptsFirstMouse:(NSEvent*)e { return YES; }
- (BOOL)mouseDownCanMoveWindow { return NO; }
- (BOOL)acceptsFirstResponder { return NO; }
- (void)emit:(const char*)kind at:(NSPoint)p extra:(std::string)extra {
  // Global top-left coordinates, like Electron's screen API on the primary display.
  char b[160];
  snprintf(b, sizeof b, "{\"type\":\"hit\",\"kind\":\"%s\",\"x\":%.1f,\"y\":%.1f", kind, p.x, PrimaryH() - p.y);
  MacEmit(std::string(b) + extra + "}");
}
- (void)mouseDown:(NSEvent*)e {
  downPt = lastPt = [NSEvent mouseLocation];
  dragging = NO;
  downCount = [e clickCount];
  [self emit:"down" at:downPt extra:",\"clickCount\":" + std::to_string((long)downCount)];
}
- (void)mouseDragged:(NSEvent*)e {
  NSPoint p = [NSEvent mouseLocation];
  if (!dragging && hypot(p.x - downPt.x, p.y - downPt.y) > 4) {
    dragging = YES;
    [self emit:"drag-start" at:downPt extra:""];
  }
  if (dragging) {
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    if (now - lastEmit > 0.033) {
      lastEmit = now;
      [self emit:"drag-move" at:p extra:""];
    }
  }
  lastPt = p;
}
- (void)mouseUp:(NSEvent*)e {
  NSPoint p = [NSEvent mouseLocation];
  if (dragging) {
    [self emit:"drag-end" at:p extra:""];
  } else {
    // A double click arrives as down, click, down, dblclick: the host holds a single click for
    // the double-click interval before acting on it (src/main/seilink/host/clicks.ts).
    [self emit:(downCount >= 2 ? "dblclick" : "click") at:p extra:",\"clickCount\":" + std::to_string((long)downCount)];
  }
  dragging = NO;
}
- (void)rightMouseDown:(NSEvent*)e { [self emit:"right-down" at:[NSEvent mouseLocation] extra:""]; }
- (void)drawRect:(NSRect)r {
  // Practically invisible, but not fully clear: the window server passes clicks on fully
  // transparent pixels of a non-opaque window through to whatever is below.
  [[NSColor colorWithCalibratedWhite:0 alpha:0.012] setFill];
  NSRectFill(r);
}
@end

@interface SeiOccObserver : NSObject
@property(nonatomic, copy) NSString* tag;
@end
@implementation SeiOccObserver
- (void)changed:(NSNotification*)n {
  NSWindow* w = n.object;
  bool vis = ([w occlusionState] & NSWindowOcclusionStateVisible) != 0;
  MacEmit(std::string("{\"type\":\"occlusion\",\"tag\":\"") + [self.tag UTF8String] + "\",\"visible\":" +
          (vis ? "true" : "false") + "}");
}
@end

// 261110: one hit panel per slot: 0 = her box, 1 = the dock (now in the screen's corner, away
// from her, so one panel over both would block the desktop between them).
static const int kHitPanelSlots = 2;
static SeiHitPanel* g_hitPanels[kHitPanelSlots] = {nil, nil};
static NSMutableArray* g_observers = nil;

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

NSRect TopLeftToCocoa(double x, double y, double w, double h) { return NSMakeRect(x, PrimaryH() - y - h, w, h); }

double Num(const Napi::Object& o, const char* k) {
  return o.Has(k) && o.Get(k).IsNumber() ? o.Get(k).As<Napi::Number>().DoubleValue() : 0;
}

void ObserveWindow(NSWindow* w, NSString* tag) {
  if (!g_observers) g_observers = [NSMutableArray array];
  SeiOccObserver* o = [SeiOccObserver new];
  o.tag = tag;
  [g_observers addObject:o];
  [[NSNotificationCenter defaultCenter] addObserver:o
                                           selector:@selector(changed:)
                                               name:NSWindowDidChangeOcclusionStateNotification
                                             object:w];
}

Napi::Value SetDesktopLevel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto out = Napi::Object::New(env);
  NSWindow* w = WindowFrom(info[0]);
  if (!w) {
    out.Set("ok", false);
    out.Set("failure", "no_window");
    return out;
  }
  NSInteger level = CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) - 1;
  [w setLevel:level];
  [w setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
                           NSWindowCollectionBehaviorIgnoresCycle];
  [w setIgnoresMouseEvents:YES];
  out.Set("ok", true);
  out.Set("wanted", (double)level);
  out.Set("level", (double)[w level]);
  NSOperatingSystemVersion v = [[NSProcessInfo processInfo] operatingSystemVersion];
  out.Set("os", std::to_string(v.majorVersion) + "." + std::to_string(v.minorVersion));
  return out;
}

Napi::Value WindowLevel(const Napi::CallbackInfo& info) {
  NSWindow* w = WindowFrom(info[0]);
  return Napi::Number::New(info.Env(), w ? (double)[w level] : -1);
}

Napi::Value OnEvents(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "onEvents: expected a callback function").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_macTsfnSet) return Napi::Boolean::New(env, false);
  g_macTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "seilink-mac", 0, 1);
  g_macTsfn.Unref(env);
  g_macTsfnSet = true;
  return Napi::Boolean::New(env, true);
}

// The slot argument at `index`, or -1 when absent / not a valid slot.
int SlotArg(const Napi::CallbackInfo& info, size_t index) {
  if (info.Length() <= index || !info[index].IsNumber()) return -1;
  int slot = info[index].As<Napi::Number>().Int32Value();
  return slot >= 0 && slot < kHitPanelSlots ? slot : -1;
}

Napi::Value HitPanel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) return Napi::Boolean::New(env, false);
  int slot = info.Length() > 1 ? SlotArg(info, 1) : 0;
  if (slot < 0) return Napi::Boolean::New(env, false);
  auto o = info[0].As<Napi::Object>();
  double w = Num(o, "w"), h = Num(o, "h");
  if (w < 1 || h < 1) return Napi::Boolean::New(env, false);
  NSRect fr = TopLeftToCocoa(Num(o, "x"), Num(o, "y"), w, h);
  SeiHitPanel* panel = g_hitPanels[slot];
  if (!panel) {
    panel = [[SeiHitPanel alloc] initWithContentRect:fr
                                           styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                             backing:NSBackingStoreBuffered
                                               defer:NO];
    [panel setOpaque:NO];
    [panel setBackgroundColor:[NSColor clearColor]];
    [panel setHasShadow:NO];
    [panel setHidesOnDeactivate:NO];
    [panel setBecomesKeyOnlyIfNeeded:YES];
    [panel setFloatingPanel:NO];
    [panel setMovable:NO];
    [panel setReleasedWhenClosed:NO];
    [panel setIgnoresMouseEvents:NO];
    [panel setAcceptsMouseMovedEvents:NO];
    [panel setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
                                 NSWindowCollectionBehaviorIgnoresCycle];
    [panel setContentView:[[SeiHitView alloc] initWithFrame:NSMakeRect(0, 0, w, h)]];
    [panel setLevel:CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1];
    ObserveWindow(panel, slot == 0 ? @"panel" : @"dock");
    g_hitPanels[slot] = panel;
  }
  [panel setFrame:fr display:YES];
  [panel orderFrontRegardless];
  return Napi::Boolean::New(env, ([panel occlusionState] & NSWindowOcclusionStateVisible) != 0);
}

Napi::Value HitPanelClose(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsNumber()) {
    int slot = SlotArg(info, 0);
    if (slot >= 0 && g_hitPanels[slot]) [g_hitPanels[slot] orderOut:nil];
    return info.Env().Undefined();
  }
  for (int i = 0; i < kHitPanelSlots; i++)
    if (g_hitPanels[i]) [g_hitPanels[i] orderOut:nil];
  return info.Env().Undefined();
}

Napi::Value ObserveOcclusion(const Napi::CallbackInfo& info) {
  NSWindow* w = WindowFrom(info[0]);
  if (!w || info.Length() < 2 || !info[1].IsString()) return Napi::Boolean::New(info.Env(), false);
  ObserveWindow(w, [NSString stringWithUTF8String:info[1].As<Napi::String>().Utf8Value().c_str()]);
  return Napi::Boolean::New(info.Env(), ([w occlusionState] & NSWindowOcclusionStateVisible) != 0);
}

Napi::Value DoubleClickMs(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), [NSEvent doubleClickInterval] * 1000.0);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platform", "darwin");
  exports.Set("setDesktopLevel", Napi::Function::New(env, SetDesktopLevel));
  exports.Set("windowLevel", Napi::Function::New(env, WindowLevel));
  exports.Set("onEvents", Napi::Function::New(env, OnEvents));
  exports.Set("hitPanel", Napi::Function::New(env, HitPanel));
  exports.Set("hitPanelClose", Napi::Function::New(env, HitPanelClose));
  exports.Set("hitPanelSlots", Napi::Number::New(env, kHitPanelSlots));
  exports.Set("observeOcclusion", Napi::Function::New(env, ObserveOcclusion));
  exports.Set("doubleClickMs", Napi::Function::New(env, DoubleClickMs));
  return exports;
}

}  // namespace

NODE_API_MODULE(seilink, Init)
