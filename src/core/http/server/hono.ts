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
import { Hono, Context } from 'hono';
import { serve } from '@hono/node-server';
import { createLogger } from '../../logging';
import { HttpContext } from '../context';

const logger = createLogger('hono');

const RoutedSymbol = Symbol.for('__routed__');

// Define Hono env type for body storage
type HonoEnv = {
  Variables: {
    body?: any;
  };
};

class Helper {
  static toReq(c: Context<HonoEnv>): Req {
    const url = new URL(c.req.url);
    const queryStringPosition = c.req.url.indexOf('?');
    return {
      method: c.req.method,
      path: url.pathname,
      headers: c.req.header(),
      query: Object.fromEntries(url.searchParams.entries()),
      queryString:
        queryStringPosition >= 0 && c.req.url.slice(queryStringPosition),
      params: c.req.param(),
      body: c.get('body'),
    } as Req;
  }

  static toRes(c: Context<HonoEnv>): Res {
    return {
      status: StatusCode.OK,
      headers: {},
    } as Res;
  }

  static corsHandler(options: Partial<CorsOptions> = {}) {
    return async (c: Context<HonoEnv>, next: () => Promise<void>) => {
      const { allowedOrigins, allowedHeaders, allowedMethods, maxAge } =
        options;
      if (c.req.method === 'OPTIONS') {
        allowedOrigins &&
          c.header(
            'Access-Control-Allow-Origin',
            [allowedOrigins].flat().join(',')
          );
        allowedHeaders &&
          c.header(
            'Access-Control-Allow-Headers',
            [allowedHeaders].flat().join(',')
          );
        allowedMethods &&
          c.header(
            'Access-Control-Allow-Methods',
            [allowedMethods].flat().join(',')
          );
        c.header('Access-Control-Max-Age', (maxAge ?? '5').toString());
        return c.body(null, StatusCode.NoContent);
      }
      await next();
    };
  }
}

export abstract class Group implements Router {
  protected router?: Hono<HonoEnv>;
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
  protected send(c: Context<HonoEnv>, response: Res | Response) {
    if (!(c as any)[RoutedSymbol]) {
      (c as any)[RoutedSymbol] = true;
      if (response instanceof Response) {
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'content-encoding') {
            c.header(key, value);
          }
        });
        c.status(response.status as any);
        // For now, convert Response to json - could be improved later
        return c.json({ data: 'Response object not fully supported yet' });
      }
      const { data, status, headers } = response;
      
      // Set custom headers first
      for (const key of Object.keys(headers ?? {})) {
        const value = headers[key];
        c.header(key, Array.isArray(value) ? value.join(',') : String(value));
      }
      
      // Set status
      c.status((status ?? StatusCode.OK) as any);
      
      if (data !== undefined) {
        // Check if Content-Type header is already set
        const existingContentType = headers && Object.keys(headers).find(
          key => key.toLowerCase() === 'content-type'
        );
        
        if (!existingContentType) {
          // Default to application/json if no content-type is set
          c.header('Content-Type', 'application/json');
          return c.json(data);
        } else {
          // Use existing content-type
          const contentType = headers[existingContentType];
          const contentTypeStr = Array.isArray(contentType) ? contentType[0] : String(contentType);
          
          if (contentTypeStr.includes('application/json')) {
            return c.json(data);
          } else {
            // For other content types, send as text or binary
            return c.body(typeof data === 'string' ? data : JSON.stringify(data));
          }
        }
      }
      return c.body(null);
    }
  }

  apply({ routes, fetcher, error }: Partial<RouteOptions>) {
    this.router = new Hono<HonoEnv>();
    
    // Add middleware to parse JSON body
    this.router.use('*', async (c, next) => {
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
        const fetch = fetcher.bind(this)(route) as (
          req: Req,
          res: Res
        ) => Promise<Res | Response>;
        const handler = async (c: Context<HonoEnv>) => {
          return this.send(c, await fetch(Helper.toReq(c), Helper.toRes(c)));
        };
        const method = route.method;
        if (method) {
          if (method === '*') {
            this.router.all(route.path, handler);
          } else {
            this.router[method.toLowerCase()](route.path, handler);
          }
        }
      }
      this.errorHandler = error;
    }
    return this;
  }

  @Step(0)
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

  @Step(2)
  _route(method: HttpMethod, path: string, handler: Handler) {
    !this.router && this.configure();
    const honoHandler = async (c: Context<HonoEnv>) => {
      try {
        return this.send(c, await handler(Helper.toReq(c), Helper.toRes(c)));
      } catch (err) {
        if (!(err instanceof HttpError)) {
          logger.error(`${err.message}\n`, err);
        }
        return this.send(c, await this.errorHandler(err, Helper.toReq(c)));
      }
    };
    
    if (method === '*') {
      this.router.all(path, honoHandler);
    } else {
      this.router[method.toLowerCase()](path, honoHandler);
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
    !this.router && this.configure();
    const filters: Filter[] = [];
    for (let i = 0; i < args.length; i++) {
      if (isClass(args[i])) {
        const group = args[i] as Class<Group>;
        const groupArgs = args.slice(i + 1);
        const g = new (class extends group {})(...groupArgs) as Group;
        !g.router &&
          g.configure(
            ...(this.filters.get('*') ?? []),
            ...filters,
            ...(this.filters.get(group) ?? [])
          );
        this.router.route(prefix, g.router);
        if (g.corsOptions) {
          this.router.options(prefix + '*', Helper.corsHandler(g.corsOptions));
        }
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
    !this.router && configure(this);
    if (this.server) {
      throw new Error('Already served!');
    }
    this.emit('start');
    
    const app = new Hono<HonoEnv>()
      .use('*', Helper.corsHandler(this.corsOptions))
      .use('*', async (c, next) => {
        // Parse JSON body
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
      })
      .use('*', async (c, next) => {
        const request = Helper.toReq(c);
        HttpContext.set({ req: request });
        this.emit('request', request);
        await next();
      })
      .route('/', this.router)
      .all('*', async (c) => {
        const { req } = HttpContext.get();
        if (this.errorHandler) {
          return this.send(c, await this.errorHandler(new NotFoundError(), req));
        } else {
          c.status(404);
          return c.json({ error: 'Not Found' });
        }
      })
      .use('*', async (c, next) => {
        this.emit('response', Helper.toReq(c), Helper.toRes(c));
        await next();
      });

    try {
      this.server = serve({
        fetch: app.fetch,
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
    }
    this.emit('stopped');
  }

  override on(event: ServerEvent, handler: Function) {
    return super.on(event, handler);
  }

  override emit(event: ServerEvent, ...data: any[]) {
    return super.emit(event, ...data);
  }
}