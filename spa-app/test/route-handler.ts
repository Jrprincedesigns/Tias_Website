/**
 * A route's loader or action, as the tests call it: a request in, a response
 * out. The routes' own argument types carry framework fields the tests never
 * set, so modules are cast to this where they are imported.
 */
export type RouteHandler = (args: { request: Request; params: Record<string, string>; context: unknown }) => Promise<Response>;
