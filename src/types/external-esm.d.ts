/**
 * Ambient declarations for the CDN-loaded ESM modules used by the optional
 * "Live 3D avatar" mode. These are resolved at runtime by an import map (see
 * src/app/layout.tsx) and loaded via `import(/* webpackIgnore: true *​/ ...)`,
 * so the bundler never touches them — TypeScript just needs the module to exist.
 */

declare module "talkinghead" {
  // The library is untyped here; we use a narrow surface.
  export class TalkingHead {
    constructor(node: HTMLElement, opts?: Record<string, unknown>);
    showAvatar(opts: Record<string, unknown>): Promise<void>;
    speakAudio(
      data: Record<string, unknown>,
      opts?: Record<string, unknown>,
      onsubtitles?: ((word: string) => void) | null,
    ): void;
    stop?(): void;
    start?(): void;
  }
}

declare module "headtts" {
  export class HeadTTS {
    constructor(opts: Record<string, unknown>);
    connect(): Promise<void>;
    setup(opts: Record<string, unknown>): void;
    synthesize(opts: { input: string }): void;
    onmessage: ((message: { type: string; data: Record<string, unknown> }) => void) | null;
  }
}
