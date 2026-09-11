export { secureResponse as proxy } from "../../src/csp";
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
