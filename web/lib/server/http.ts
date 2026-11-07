import "server-only";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

/** Wrap a route body: JSON out, HttpError -> status + {detail}. */
export async function handle<T>(fn: () => Promise<T> | T): Promise<Response> {
  try {
    const out = await fn();
    if (out instanceof Response) return out;
    return Response.json(out ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ detail: e.message, ...e.extra }, { status: e.status });
    console.error(e);
    return Response.json({ detail: `Unexpected error: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

export const num = (v: unknown, lo: number, hi: number, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(422, `${name} must be between ${lo} and ${hi}`);
  return n;
};
