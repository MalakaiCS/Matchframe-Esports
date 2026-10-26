import { getOperatorToken } from "./auth.ts";
import { createApiClient } from "./client.ts";

/** Operator API client (bearer token from the operator session). */
export const api = createApiClient(getOperatorToken);

export { ApiError, NetworkError, describeError, seg } from "./client.ts";
