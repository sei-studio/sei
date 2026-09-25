/**
 * One shared lazy import of the analytics module (260926).
 *
 * The game surfaces import analytics lazily (CLAUDE.md, "Instrumenting a game
 * or timed surface") so their module graphs and tests never depend on it being
 * initialized. Each capture site used to run its own `import('./analytics')`.
 * When two fire in the same tick (a turn's surface-error capture and the
 * credit-wall event right after it), vitest's module mocking can resolve the
 * concurrent imports to DIFFERENT instances, one of them the real module, so
 * a mocked capture silently never sees the event. One cached promise keeps
 * every site on the same instance. In the app it is simply the same module.
 */
let analyticsModule: Promise<typeof import('./analytics')> | null = null;

export function loadAnalytics(): Promise<typeof import('./analytics')> {
  analyticsModule ??= import('./analytics').catch((err) => {
    analyticsModule = null;
    throw err;
  });
  return analyticsModule;
}
