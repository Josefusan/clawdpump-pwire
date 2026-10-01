// Minimal shim: @types/express is not installed (no registry access for this card).
declare module 'express' {
  export interface Request {
    params: Record<string, string>;
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
    protocol: string;
    get(name: string): string | undefined;
  }
  export interface Response {
    status(code: number): Response;
    set(name: string, value: string): Response;
    json(body: unknown): Response;
    send(body: string): Response;
  }
  export type NextFunction = (err?: unknown) => void;
  export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
  export interface Express {
    get(path: string, ...handlers: Handler[]): Express;
    use(...handlers: Handler[]): Express;
    use(path: string, ...handlers: Handler[]): Express;
    set(name: string, value: unknown): Express;
    disable(name: string): Express;
    listen(port: number, cb?: () => void): import('node:http').Server;
  }
  interface ExpressStatic {
    (): Express;
    /** express.static(root, opts) — serves files under root; `fallthrough: false` makes misses 404 instead of falling through. */
    static(root: string, options?: { index?: string | false; fallthrough?: boolean; dotfiles?: 'allow' | 'deny' | 'ignore' }): Handler;
  }
  const express: ExpressStatic;
  export default express;
}
