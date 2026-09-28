export function ChatIcon({
  name,
}: {
  name:
    | "edit"
    | "lock"
    | "shieldCheck"
    | "shieldBolt"
    | "queue"
    | "microphone"
    | "copy"
    | "quote"
    | "attachment"
    | "command"
    | "plan"
    | "plus"
    | "chevron"
    | "bolt"
    | "send"
    | "stop"
    | "shield"
    | "more"
    | "close"
    | "check";
}) {
  const paths = {
    edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Zm0 0h16",
    lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Zm7 4v3",
    shieldCheck: "m12 3 7 3v5c0 5-7 10-7 10S5 16 5 11V6l7-3Zm-4 9 3 3 5-6",
    shieldBolt: "m12 3 7 3v5c0 5-7 10-7 10S5 16 5 11V6l7-3Zm1 4-4 6h4l-2 5 5-7h-4l1-4",
    queue: "M4 6h11M4 12h7M4 18h7m6-8v10m-4-4 4 4 4-4",
    microphone: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v3",
    copy: "M8 8h11v12H8ZM5 16H3V3h12v2",
    quote: "M4 6h6v6H5c0 3 1 4 3 5m6-11h6v6h-5c0 3 1 4 3 5",
    attachment: "M8 12v5a4 4 0 0 0 8 0V7a3 3 0 0 0-6 0v10a1 1 0 0 0 2 0V8",
    command: "m9 5-5 7 5 7m6-14 5 7-5 7",
    plan: "M9 18h6m-5 3h4M8 13a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z",
    plus: "M12 5v14M5 12h14",
    chevron: "m8 10 4 4 4-4",
    bolt: "m13.5 2-9 12h7l-1 8 9-13h-7l1-7Z",
    stop: "M7 7h10v10H7Z",
    send: "M12 19V5m-6 6 6-6 6 6",
    shield: "m12 3 7 3v5c0 5-7 10-7 10S5 16 5 11V6l7-3Zm0 5v4m0 3v.1",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    close: "m6 6 12 12M6 18 18 6",
    check: "m5 12 4 4L19 6",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} fill={name === "stop" ? "currentColor" : "none"} stroke={name === "stop" ? "none" : undefined} />
    </svg>
  );
}
