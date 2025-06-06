import { Jwt } from '../../core/jwt';
import {
  Filter,
  Req,
  RequestDecorator,
  Res,
  UnauthorizedError,
} from '../../core/http';
import { RbacValidator } from '../../core/rbac';
import { Role } from '../../core/types';
import { beanOf } from '../../core/ioc';

/**
 * An authorized {@link Req}uest.
 */
export type AuthReq<T = any> = Req<T> & {
  /**
   * Authorization info.
   */
  _auth: {
    id: number;
    email: string;
    roles: Role[];
  };
};

/**
 * Extracts necessary information from an {@link AuthReq}.
 */
export type ReqVerifier<T = any> = (req: AuthReq<T>) =>
  | {
      id: number;
      email: string;
      roles: Role[];
    }
  | undefined;

type Permission = string | ((req: Req) => string);

/**
 * Creates a {@link Filter} with a custom {@link ReqVerifier}.
 */
export function authFilter<T = any>(verifier: ReqVerifier<T>): Filter<T> {
  return async (req: AuthReq<T>, res: Res, ...permissions: Permission[]) => {
    try {
      const { id, email, roles = ['anonymous'] } = verifier(req) ?? {};
      const validator = beanOf(RbacValidator, true) ?? new RbacValidator();
      const validationSkipped = permissions.length === 0 || !validator.enabled;
      let accessible = id && email && validationSkipped;
      if (!validationSkipped) {
        for (const permission of permissions) {
          if (accessible) {
            break;
          }
          const perm =
            permission instanceof Function ? permission(req) : permission;
          for (const role of roles) {
            accessible = validator.check(perm, role);
            if (accessible) {
              break;
            }
          }
        }
      }
      if (accessible) {
        Object.defineProperty(req, '_auth', {
          value: { id, email, roles },
        });
        return { req, res };
      }
    } catch {}
    throw new UnauthorizedError('Unauthorized');
  };
}

/**
 * A {@link Jwt} {@link Filter}.
 */
export async function jwt<T = any>(
  req: AuthReq<T>,
  res: Res,
  ...permissions: Permission[]
) {
  return authFilter<T>(({ headers }) => {
    const authorization = headers?.authorization as string;
    const token = authorization?.replace(/^[Bb]earer\s+/g, '')?.trim();
    return beanOf(Jwt).verify(token);
  })(req, res, ...permissions);
}

/**
 * Indicates a method as authorization-required.
 * It uses {@link Jwt} verification internally.
 *
 * It must be used before any {@link RequestDecorator}-made decorator.
 */
export function Auth(...permissions: Permission[]) {
  return function (
    target: any,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<any>
  ) {
    const handler = descriptor.value;
    descriptor.value = async function <T>(req: AuthReq<T>, res: Res) {
      const authorized = await jwt<T>(req, res, ...permissions);
      return handler.bind(this)(authorized.req, authorized.res);
    };
  };
}
