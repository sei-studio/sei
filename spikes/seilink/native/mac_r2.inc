// SeiLink spike round 2 (macOS): native hit layer over the companion box + occlusion signal.
// Included from mac.mm (top level, after the round-1 classes).
//
// hitPanel({x,y,w,h,level}): a borderless NSWindowStyleMaskNonactivatingPanel NSPanel at
//   kCGDesktopIconWindowLevel+1 (above Finder's icons, below every normal window). Its view turns
//   mouseDown/Dragged/Up into click / dblclick / drag-start / drag-move / drag-end events (JSON
//   via onEvents(cb)). The panel never becomes key or main and is not movable, so AppKit has no
//   reason to activate the app, and the click lands on our window instead of the wallpaper, so
//   WindowManager's "click wallpaper to reveal desktop" never sees it.
// observeOcclusion(handle, tag): NSWindowDidChangeOcclusionStateNotification -> {type:'occlusion'}.

static Napi::ThreadSafeFunction g_macTsfn;
static bool g_macTsfnSet = false;

static std::string MacEsc(const std::string& s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o;
}

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

@interface SeiHitView2 : NSView {
 @public
  NSPoint downPt, lastPt;
  BOOL dragging;
  NSInteger downCount;
  int moves;
  double dist;
  NSTimeInterval lastEmit;
  int downs;
}
@end
@implementation SeiHitView2
- (BOOL)acceptsFirstMouse:(NSEvent*)e { return YES; }
- (BOOL)mouseDownCanMoveWindow { return NO; }
- (BOOL)acceptsFirstResponder { return NO; }
- (void)emit:(const char*)kind at:(NSPoint)p extra:(std::string)extra {
  // Global top-left coordinates, like Electron's screen API on the primary display.
  char b[256];
  snprintf(b, sizeof b, "{\"type\":\"hit\",\"kind\":\"%s\",\"x\":%.1f,\"y\":%.1f,\"appActive\":%s,\"t\":%.0f", kind, p.x,
           PrimaryH() - p.y, [NSApp isActive] ? "true" : "false", [[NSDate date] timeIntervalSince1970] * 1000);
  MacEmit(std::string(b) + extra + "}");
}
- (void)mouseDown:(NSEvent*)e {
  downs++;
  downPt = lastPt = [NSEvent mouseLocation];
  dragging = NO;
  downCount = [e clickCount];
  moves = 0;
  dist = 0;
  [self emit:"down" at:downPt extra:",\"clickCount\":" + std::to_string((long)downCount)];
}
- (void)mouseDragged:(NSEvent*)e {
  NSPoint p = [NSEvent mouseLocation];
  if (!dragging && hypot(p.x - downPt.x, p.y - downPt.y) > 4) {
    dragging = YES;
    [self emit:"drag-start" at:downPt extra:""];
  }
  if (dragging) {
    moves++;
    dist += hypot(p.x - lastPt.x, p.y - lastPt.y);
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    if (now - lastEmit > 0.033) {
      lastEmit = now;
      [self emit:"drag-move" at:p extra:",\"moves\":" + std::to_string(moves)];
    }
  }
  lastPt = p;
}
- (void)mouseUp:(NSEvent*)e {
  NSPoint p = [NSEvent mouseLocation];
  if (dragging) {
    char b[96];
    snprintf(b, sizeof b, ",\"moves\":%d,\"dist\":%.1f", moves, dist);
    [self emit:"drag-end" at:p extra:b];
  } else {
    [self emit:(downCount >= 2 ? "dblclick" : "click") at:p extra:",\"clickCount\":" + std::to_string((long)downCount)];
  }
  dragging = NO;
}
- (void)rightMouseDown:(NSEvent*)e { [self emit:"right-down" at:[NSEvent mouseLocation] extra:""]; }
- (void)drawRect:(NSRect)r {
  // Spike-visible tint (the product layer would be fully clear).
  [[NSColor colorWithCalibratedRed:0 green:0.8 blue:1 alpha:0.35] setFill];
  NSRectFill(r);
}
@end

static SeiHitPanel* g_hitPanel = nil;

@interface SeiOccObserver : NSObject
@property(nonatomic, copy) NSString* tag;
@end
@implementation SeiOccObserver
- (void)changed:(NSNotification*)n {
  NSWindow* w = n.object;
  bool vis = ([w occlusionState] & NSWindowOcclusionStateVisible) != 0;
  MacEmit(std::string("{\"type\":\"occlusion\",\"tag\":\"") + MacEsc([self.tag UTF8String]) + "\",\"visible\":" +
          (vis ? "true" : "false") + ",\"t\":" + std::to_string((long long)([[NSDate date] timeIntervalSince1970] * 1000)) + "}");
}
@end
static NSMutableArray* g_observers = nil;

namespace {

NSRect TopLeftToCocoa(double x, double y, double w, double h) { return NSMakeRect(x, PrimaryH() - y - h, w, h); }

Napi::Value OnEvents(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_macTsfnSet) return Napi::Boolean::New(env, false);
  g_macTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "seilink-mac", 0, 1);
  g_macTsfn.Unref(env);
  g_macTsfnSet = true;
  return Napi::Boolean::New(env, true);
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

Napi::Value HitPanel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto o = info[0].As<Napi::Object>();
  double x = o.Get("x").As<Napi::Number>().DoubleValue(), y = o.Get("y").As<Napi::Number>().DoubleValue();
  double w = o.Get("w").As<Napi::Number>().DoubleValue(), h = o.Get("h").As<Napi::Number>().DoubleValue();
  NSInteger level = o.Has("level") ? (NSInteger)o.Get("level").As<Napi::Number>().Int64Value()
                                   : CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1;
  NSRect fr = TopLeftToCocoa(x, y, w, h);
  if (!g_hitPanel) {
    g_hitPanel = [[SeiHitPanel alloc] initWithContentRect:fr
                                                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    [g_hitPanel setOpaque:NO];
    [g_hitPanel setBackgroundColor:[NSColor clearColor]];
    [g_hitPanel setHasShadow:NO];
    [g_hitPanel setHidesOnDeactivate:NO];
    [g_hitPanel setBecomesKeyOnlyIfNeeded:YES];
    [g_hitPanel setFloatingPanel:NO];
    [g_hitPanel setMovable:NO];
    [g_hitPanel setReleasedWhenClosed:NO];
    [g_hitPanel setIgnoresMouseEvents:NO];
    [g_hitPanel setAcceptsMouseMovedEvents:NO];
    [g_hitPanel setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
                                      NSWindowCollectionBehaviorIgnoresCycle];
    [g_hitPanel setContentView:[[SeiHitView2 alloc] initWithFrame:NSMakeRect(0, 0, w, h)]];
    ObserveWindow(g_hitPanel, @"panel");
  }
  [g_hitPanel setLevel:level];
  [g_hitPanel setFrame:fr display:YES];
  [g_hitPanel orderFrontRegardless];
  return WinObj(env, g_hitPanel);
}

Napi::Value HitPanelSetRect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_hitPanel) return env.Null();
  auto o = info[0].As<Napi::Object>();
  NSRect fr = TopLeftToCocoa(o.Get("x").As<Napi::Number>().DoubleValue(), o.Get("y").As<Napi::Number>().DoubleValue(),
                             o.Get("w").As<Napi::Number>().DoubleValue(), o.Get("h").As<Napi::Number>().DoubleValue());
  [g_hitPanel setFrame:fr display:YES];
  return WinObj(env, g_hitPanel);
}

Napi::Value HitPanelInfo(const Napi::CallbackInfo& info) { return WinObj(info.Env(), g_hitPanel); }

Napi::Value HitPanelClose(const Napi::CallbackInfo& info) {
  if (g_hitPanel) [g_hitPanel orderOut:nil];
  return info.Env().Undefined();
}

Napi::Value ObserveOcclusion(const Napi::CallbackInfo& info) {
  NSWindow* w = WindowFrom(info[0]);
  if (!w) return Napi::Boolean::New(info.Env(), false);
  ObserveWindow(w, [NSString stringWithUTF8String:info[1].As<Napi::String>().Utf8Value().c_str()]);
  return Napi::Boolean::New(info.Env(), ([w occlusionState] & NSWindowOcclusionStateVisible) != 0);
}

Napi::Value FrontmostInfo(const Napi::CallbackInfo& info) {
  auto o = Napi::Object::New(info.Env());
  NSRunningApplication* a = [[NSWorkspace sharedWorkspace] frontmostApplication];
  o.Set("name", a ? std::string([[a localizedName] UTF8String] ?: "") : "");
  o.Set("pid", a ? (double)[a processIdentifier] : 0.0);
  o.Set("bundle", a && [a bundleIdentifier] ? std::string([[a bundleIdentifier] UTF8String]) : "");
  return o;
}

Napi::Value AppActive(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), [NSApp isActive] || [[NSRunningApplication currentApplication] isActive]);
}

// ---- TEST HARNESS ONLY: synthetic hand (CGEventPost, needs Accessibility like round 1).
void Post(CGEventType t, CGPoint p, int clickState) {
  CGEventRef e = CGEventCreateMouseEvent(nullptr, t, p, kCGMouseButtonLeft);
  if (clickState) CGEventSetIntegerValueField(e, kCGMouseEventClickState, clickState);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

Napi::Value TestDoubleClick(const Napi::CallbackInfo& info) {
  CGPoint p = CGPointMake(info[0].As<Napi::Number>().DoubleValue(), info[1].As<Napi::Number>().DoubleValue());
  Post(kCGEventMouseMoved, p, 0);
  usleep(60000);
  Post(kCGEventLeftMouseDown, p, 1);
  usleep(30000);
  Post(kCGEventLeftMouseUp, p, 1);
  usleep(90000);
  Post(kCGEventLeftMouseDown, p, 2);
  usleep(30000);
  Post(kCGEventLeftMouseUp, p, 2);
  return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

// testDrag(x0,y0,x1,y1,steps): press, move in steps (a headpat stroke back and forth), release.
Napi::Value TestDrag(const Napi::CallbackInfo& info) {
  double x0 = info[0].As<Napi::Number>().DoubleValue(), y0 = info[1].As<Napi::Number>().DoubleValue();
  double x1 = info[2].As<Napi::Number>().DoubleValue(), y1 = info[3].As<Napi::Number>().DoubleValue();
  int steps = info.Length() > 4 ? info[4].As<Napi::Number>().Int32Value() : 20;
  Post(kCGEventMouseMoved, CGPointMake(x0, y0), 0);
  usleep(60000);
  Post(kCGEventLeftMouseDown, CGPointMake(x0, y0), 1);
  usleep(40000);
  for (int i = 1; i <= steps; i++) {
    double f = (double)i / steps;
    double k = f < 0.5 ? f * 2 : (1 - f) * 2;  // there and back
    Post(kCGEventLeftMouseDragged, CGPointMake(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k), 1);
    usleep(16000);
  }
  Post(kCGEventLeftMouseUp, CGPointMake(x0, y0), 1);
  return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

Napi::Value TestKey(const Napi::CallbackInfo& info) {
  CGKeyCode k = (CGKeyCode)info[0].As<Napi::Number>().Uint32Value();
  uint64_t flags = info.Length() > 1 ? (uint64_t)info[1].As<Napi::Number>().Int64Value() : 0;
  CGEventRef d = CGEventCreateKeyboardEvent(nullptr, k, true), u = CGEventCreateKeyboardEvent(nullptr, k, false);
  if (flags) {
    CGEventSetFlags(d, (CGEventFlags)flags);
    CGEventSetFlags(u, (CGEventFlags)flags);
  }
  CGEventPost(kCGHIDEventTap, d);
  usleep(40000);
  CGEventPost(kCGHIDEventTap, u);
  CFRelease(d);
  CFRelease(u);
  return info.Env().Undefined();
}

AXUIElementRef AxFirstWindow(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFArrayRef wins = nullptr;
  AXUIElementRef w = nullptr;
  if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef*)&wins) == kAXErrorSuccess && wins) {
    if (CFArrayGetCount(wins) > 0) w = (AXUIElementRef)CFRetain(CFArrayGetValueAtIndex(wins, 0));
    CFRelease(wins);
  }
  CFRelease(app);
  return w;
}

// axSetFrame(pid, {x,y,w,h}) moves/resizes another app's first window (top-left coords).
Napi::Value AxSetFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t pid = (pid_t)info[0].As<Napi::Number>().Int32Value();
  auto o = info[1].As<Napi::Object>();
  AXUIElementRef w = AxFirstWindow(pid);
  if (!w) return Napi::String::New(env, "no window");
  CGPoint pt = CGPointMake(o.Get("x").As<Napi::Number>().DoubleValue(), o.Get("y").As<Napi::Number>().DoubleValue());
  CGSize sz = CGSizeMake(o.Get("w").As<Napi::Number>().DoubleValue(), o.Get("h").As<Napi::Number>().DoubleValue());
  AXValueRef pv = AXValueCreate((AXValueType)kAXValueCGPointType, &pt);
  AXValueRef sv = AXValueCreate((AXValueType)kAXValueCGSizeType, &sz);
  AXError e1 = AXUIElementSetAttributeValue(w, kAXPositionAttribute, pv);
  AXError e2 = AXUIElementSetAttributeValue(w, kAXSizeAttribute, sv);
  CFRelease(pv);
  CFRelease(sv);
  CFRelease(w);
  return Napi::String::New(env, "pos=" + std::to_string(e1) + " size=" + std::to_string(e2));
}

Napi::Value AxSetFullscreen(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  AXUIElementRef w = AxFirstWindow((pid_t)info[0].As<Napi::Number>().Int32Value());
  if (!w) return Napi::String::New(env, "no window");
  AXError e = AXUIElementSetAttributeValue(w, CFSTR("AXFullScreen"), info[1].ToBoolean().Value() ? kCFBooleanTrue : kCFBooleanFalse);
  CFRelease(w);
  return Napi::String::New(env, "err=" + std::to_string(e));
}

}  // namespace
