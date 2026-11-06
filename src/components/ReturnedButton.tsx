import { setReturned } from "@/app/actions/guests";
import { SubmitButton } from "@/components/SubmitButton";

export function ReturnedButton({ visitorId, returned }: { visitorId: string; returned: boolean }) {
  return (
    <form action={setReturned.bind(null, visitorId, !returned)}>
      {returned ? (
        <SubmitButton className="btn btn-sm btn-sage" pendingText="…">✓ Returned</SubmitButton>
      ) : (
        <SubmitButton className="btn btn-sm btn-secondary" pendingText="Saving…">Mark returned</SubmitButton>
      )}
    </form>
  );
}
