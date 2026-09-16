import EmployeeMessage from "../message-ui";
export const dynamic = "force-dynamic";
// The employee message entry point. The organization link arrives in the URL
// fragment, so it is never part of the request this page is rendered from.
export default function Page() {
  return <EmployeeMessage />;
}
