/// <reference lib="webworker" />
import { runCompute, type ComputeRequest } from './computeCore';

interface Msg {
  id: number;
  req: ComputeRequest;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<Msg>) => {
  const { id, req } = ev.data;
  ctx.postMessage({ id, res: runCompute(req) });
});
