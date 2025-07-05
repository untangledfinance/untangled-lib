import {
  configure,
  CorsOptions,
  Filter,
  FilterOptions,
  Handler,
  HttpMethod,
  Req,
  Res,
  RouteOptions,
  Router,
  ServeOptions,
  Server,
  StatusCode,
} from '../core';
import { HttpError, NotFoundError } from '../error';
import { isClass, profiles } from '../../types';
import { Step } from '../../validation';
import { Hono, Context, Env } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from '../../logging';
import { serve } from '@hono/node-server';

const logger = createLogger('hono');

// Define Hono env type for body storage
type HonoEnv = {
  Variables: {
    body?: any;
  };
};

class Mapper {
  static toReq(c: Context<HonoEnv>): Req {
    const url = new URL(c.req.url);
    // Get headers as an object
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(c.req.header())) {
      headers[key] = value;
    }
    
    return {
      method: c.req.method,
      path: url.pathname,
      url: c.req.url,
      headers,
      query: Object.fromEntries(url.searchParams.entries()),
      queryString: url.search,
      params: c.req.param(),
      body: c.get('body'), // Body will be set via middleware
    } as Req;
  }

  static toRes(c: Context<HonoEnv>): Res {
    return {
      status: 200, // Default status
      headers: {},
    } as Res;
  }

  static corsOptions(options: Partial<CorsOptions>) {
    return {
      origin: options.allowedOrigins 
        ? Array.isArray(options.allowedOrigins)
          ? options.allowedOrigins
          : [options.allowedOrigins]
        : ['*'],
      allowMethods: options.allowedMethods
        ? Array.isArray(options.allowedMethods)
          ? options.allowedMethods
          : [options.allowedMethods]
        : ['*'],
      allowHeaders: options.allowedHeaders
        ? Array.isArray(options.allowedHeaders)
          ? options.allowedHeaders
          : [options.allowedHeaders]
        : ['*'],
      maxAge: options.maxAge ? Number(options.maxAge) : 5,
    };
  }
}

export abstract class Group implements Router {
  protected honoApp?: Hono<HonoEnv>;
  protected corsOptions?: Partial<CorsOptions>;
  protected errorHandler?: (err: Error, req: Req) => Promise<Res>;
  private eventHandlers: Map<string, Function[]> = new Map();
  private filters: Map<Class<Router> | '*', Filter[]> = new Map();

  protected configure(...filters: Filter[]) {
    configure(this, ...(this.filters.get('*') ?? []), ...filters);
  }

  @Step(1)
  with({ guard: filter, before }: FilterOptions) {
    const routers = before instanceof Array ? before : [before];
    routers.forEach((rc) => {
      const fs = this.filters.get(rc) ?? [];
      fs.push(filter);
      this.filters.set(rc, fs);
    });
    return this;
  }

  @Step(1)
  guard(filter: Filter) {
    this.filters.set('*', [...(this.filters.get('*') ?? []), filter]);
    return this;
  }

  /**
   * Tries sending the {@link Res}.
   */
  protected send(c: Context<HonoEnv>, { data, status, headers }: Res): Response {
    // Set headers
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        c.header(key, Array.isArray(value) ? value.join(',') : String(value));
      }
    }

    // Set status
    c.status((status ?? StatusCode.OK) as any);

    // Return response with data
    if (data !== undefined) {
      return c.json(data);
    }
    return c.body(null);
  }

  apply({ routes, fetcher, error }: Partial<RouteOptions>) {
    this.honoApp = new Hono<HonoEnv>();
    this.errorHandler = error;

    // Add middleware to parse body
    this.honoApp.use('*', async (c, next) => {
      try {
        const contentType = c.req.header('content-type');
        if (contentType?.includes('application/json')) {
          const body = await c.req.json();
          c.set('body', body);
        } else if (contentType?.includes('application/x-www-form-urlencoded')) {
          const body = await c.req.parseBody();
          c.set('body', body);
        }
      } catch (err) {
        // Body parsing failed, continue without body
      }
      await next();
    });

    if (routes?.length && fetcher) {
      for (const route of routes) {
        const fetch = fetcher.bind(this)(route);
        const method = route.method.toLowerCase();
        const path = route.path;

        const handler = async (c: Context<HonoEnv>) => {
          try {
            const req = Mapper.toReq(c);
            const res = Mapper.toRes(c);
            const result = await fetch(req, res);
            return this.send(c, result);
          } catch (err) {
            if (!(err instanceof HttpError)) {
              logger.error(`${err.message}\n`, err);
            }
            const req = Mapper.toReq(c);
            const errorRes = await this.errorHandler(err, req);
            return this.send(c, errorRes);
          }
        };

        if (method === '*') {
          this.honoApp.all(path, handler);
        } else {
          this.honoApp.on(method.toUpperCase(), path, handler);
        }
      }
    }

    if (error) {
      this.errorHandler = error;
    }

    return this;
  }

  cors(options: Partial<CorsOptions> | '*') {
    if (options === '*') {
      this.corsOptions = {
        allowedOrigins: ['*'],
        allowedMethods: ['*'],
        allowedHeaders: ['*'],
      };
    } else {
      this.corsOptions = options;
    }
    return this;
  }

  _route(method: HttpMethod, path: string, handler: Handler) {
    !this.honoApp && this.configure();

    const honoHandler = async (c: Context<HonoEnv>) => {
      try {
        const req = Mapper.toReq(c);
        const res = Mapper.toRes(c);
        const result = await handler(req, res);
        return this.send(c, result);
      } catch (err) {
        if (!(err instanceof HttpError)) {
          logger.error(`${err.message}\n`, err);
        }
        const req = Mapper.toReq(c);
        const errorRes = await this.errorHandler(err, req);
        return this.send(c, errorRes);
      }
    };

    if (method === '*') {
      this.honoApp.all(path, honoHandler);
    } else {
      this.honoApp.on(method, path, honoHandler);
    }

    return this;
  }

  route(method: HttpMethod, path: string, handler: Handler) {
    return this._route(method, path, handler);
  }

  /**
   * @see {@link route}.
   */
  get(path: string, handler: Handler) {
    return this._route('GET', path, handler);
  }

  /**
   * @see {@link route}.
   */
  post(path: string, handler: Handler) {
    return this._route('POST', path, handler);
  }

  /**
   * @see {@link route}.
   */
  put(path: string, handler: Handler) {
    return this._route('PUT', path, handler);
  }

  /**
   * @see {@link route}.
   */
  patch(path: string, handler: Handler) {
    return this._route('PATCH', path, handler);
  }

  /**
   * @see {@link route}.
   */
  delete(path: string, handler: Handler) {
    return this._route('DELETE', path, handler);
  }

  @Step(2)
  _use(prefix: string, ...args: [...Filter[], Class<Group>, ...any]) {
    !this.honoApp && this.configure();
    const filters: Filter[] = [];
    for (let i = 0; i < args.length; i++) {
      if (isClass(args[i])) {
        const group = args[i] as Class<Group>;
        const groupArgs = args.slice(i + 1);
        const g = new (class extends group {})(...groupArgs) as Group;
        !g.honoApp &&
          g.configure(
            ...(this.filters.get('*') ?? []),
            ...filters,
            ...(this.filters.get(group) ?? [])
          );
        
        // Mount the sub-application
        this.honoApp.route(prefix, g.honoApp);
        break;
      }
      filters.push(args[i] as Filter);
    }
    return this;
  }

  use(prefix: string, group: Class<Group>, ...args: any[]) {
    return this._use(prefix, group, ...args);
  }

  on(event: string, handler: Function) {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
    return this;
  }

  emit(event: string, ...data: any[]) {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.forEach((handler) => handler(...data));
    return this;
  }
}

/**
 * Events emitted by the {@link Server}.
 */
type ServerEvent =
  | 'crashed'
  | 'start'
  | 'started'
  | 'stop'
  | 'stopped'
  | 'request'
  | 'response';

/**
 * A Hono-embedded HTTP server.
 */
export abstract class Application extends Group implements Server {
  private server?: any;

  async start({ host, port }: Partial<ServeOptions>) {
    !this.honoApp && configure(this);

    if (this.server) {
      throw new Error('Already served!');
    }

    this.emit('start');

    // Setup CORS if configured
    if (this.corsOptions) {
      this.honoApp.use('*', cors(Mapper.corsOptions(this.corsOptions)));
    }

    // Request event middleware
    this.honoApp.use('*', async (c, next) => {
      this.emit('request', Mapper.toReq(c));
      await next();
      this.emit('response', Mapper.toReq(c), Mapper.toRes(c));
    });

    // Not found handler
    this.honoApp.notFound(async (c) => {
      if (this.errorHandler) {
        const req = Mapper.toReq(c);
        const res = await this.errorHandler(new NotFoundError(), req);
        return this.send(c, res);
      } else {
        c.status(404);
        return c.json({ error: 'Not Found' });
      }
    });

    // Error handler
    this.honoApp.onError(async (err, c) => {
      if (!(err instanceof HttpError)) {
        logger.error(`${err.message}\n`, err);
      }

      if (this.errorHandler) {
        const req = Mapper.toReq(c);
        const res = await this.errorHandler(err, req);
        return this.send(c, res);
      } else {
        c.status(500);
        return c.json({ error: 'Internal Server Error' });
      }
    });

    try {
      // Start the server using @hono/node-server
      this.server = serve({
        fetch: this.honoApp.fetch,
        port: port || 3000,
        hostname: host || '0.0.0.0',
      });

      this.emit('started', {
        app: {
          type: 'hono',
          env: process.env.ENV,
          profiles: [...profiles()],
          host,
          port,
        },
      });

      return this;
    } catch (err) {
      this.emit('crashed', err);
      throw err;
    }
  }

  async stop() {
    this.emit('stop');
    if (this.server) {
      // @hono/node-server doesn't provide a stop method directly
      // but we can close it if it has the close method
      if (this.server.close) {
        this.server.close();
      }
      this.server = undefined;
      this.emit('stopped');
    }
  }

  override on(event: ServerEvent, handler: Function) {
    return super.on(event, handler);
  }

  override emit(event: ServerEvent, ...data: any[]) {
    return super.emit(event, ...data);
  }
}