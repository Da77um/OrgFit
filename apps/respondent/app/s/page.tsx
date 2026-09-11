import Survey from "../survey-ui";
export const dynamic = "force-dynamic";
// The survey entry point. The invitation token arrives in the URL fragment, so
// it is never part of the request this page is rendered from.
export default function Page() {
  return <Survey />;
}
