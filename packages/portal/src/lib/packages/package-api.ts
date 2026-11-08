// Error answers for the v1 package routes.

import { apiError, type ApiContext } from '../api-auth';
import { packageFailureBody } from './package-requests';

/** A refused package request as a v1 error; unexpected errors are rethrown. */
export function packageApiFailure(error: unknown, ctx: ApiContext): Response {
  const refused = packageFailureBody(error);
  if (!refused) throw error;
  return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code, ...(refused.body.details ? { details: refused.body.details } : {}) });
}
