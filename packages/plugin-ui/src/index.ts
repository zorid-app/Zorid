import type { FileRendererContribution, FileRendererMountContext } from '@zorid/platform-api';
import type { Disposable } from '@zorid/shared';
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';

export { createEffect, createSignal, For, onCleanup, Show };

export type PluginUIComponent<P = Record<string, never>> = (props: P) => JSX.Element;

export interface PluginUIMountOptions<P extends object = FileRendererMountContext> {
  readonly component: PluginUIComponent<P>;
  readonly props?: (ctx: FileRendererMountContext) => P;
}

export function mountPluginUI<P extends object = FileRendererMountContext>({
  component,
  props,
}: PluginUIMountOptions<P>): FileRendererContribution['mount'] {
  return (ctx) => {
    const disposables: Disposable[] = [];
    const registerDisposable = (disposable: Disposable | (() => void | Promise<void>)): void => {
      disposables.push(typeof disposable === 'function' ? { dispose: disposable } : disposable);
    };
    const mountContext = { ...ctx, dispose: registerDisposable };
    const dispose = render(() => component(props ? props(mountContext) : (mountContext as P)), ctx.root);
    ctx.dispose(() => {
      for (const disposable of disposables.splice(0)) void disposable.dispose();
      dispose();
    });
  };
}
