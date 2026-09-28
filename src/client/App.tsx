import { useCallback, useEffect, useRef, useState } from "react";
import type { AnswerDto, MessageBody, MessageListItem, MessagePage } from "../contracts/dto";
import { QUESTION_LABELS, TRAY_LABELS, type Question, type Tray } from "../contracts/ui-types";
import {
  fetchBody,
  fetchSyncStatus,
  listMessages,
  submitCorrection,
} from "./api";

const TRAY_ORDER: Tray[] = [
  "needs_reply",
  "action",
  "review",
  "updates",
  "low_priority",
];

// Valid correction targets per question. A correction must always carry a
// value the schema accepts, so the editor cannot produce an invalid answer.
const OPTIONS: Record<Question, readonly AnswerDto["value"][]> = {
  category: [
    "personal",
    "work",
    "transactional",
    "newsletter",
    "marketing",
    "cold_outreach",
    "notification",
    "other",
  ],
  needsReply: [true, false],
  needsAction: [true, false],
  urgency: [1, 2, 3, 4, 5],
  importance: [1, 2, 3, 4, 5],
  senderType: ["person", "organization", "automated", "unknown"],
};

function display(option: AnswerDto["value"]): string {
  if (typeof option === "boolean") return option ? "yes" : "no";
  return String(option);
}

function isSelected(answer: AnswerDto, option: AnswerDto["value"]): boolean {
  return answer.state === "value" && answer.value === option;
}

function formatValue(answer: AnswerDto): string {
  if (answer.state !== "value" || answer.value === undefined) return "not answered";
  const value = answer.value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function AnswerRow({ answer }: { answer: AnswerDto }) {
  const unknown = answer.state !== "value";
  return (
    <div className={`answer${unknown ? " unknown" : ""}${answer.corrected ? " corrected" : ""}`}>
      <span className="label">{QUESTION_LABELS[answer.question as Question]}</span>
      <span className="value">{formatValue(answer)}</span>
      {!unknown && answer.confidence !== null && (
        <span className="confidence">{(answer.confidence * 100).toFixed(0)}%</span>
      )}
      {!unknown && answer.confidence === null && answer.corrected && (
        <span className="confidence">your call</span>
      )}
    </div>
  );
}

function MessageRow({
  item,
  selected,
  onSelect,
}: {
  item: MessageListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className="row" aria-current={selected} onClick={onSelect}>
      <div className={`subject${item.isUnread ? " unread" : ""}`}>{item.subject}</div>
      <div className="sender">{item.sender}</div>
      <div className="meta">
        {TRAY_LABELS[item.tray]}
        {item.pendingInThread > 0 && ` · ${item.pendingInThread} new in thread`}
        {item.uncertain && " · needs review"}
      </div>
    </button>
  );
}

function Reader({
  item,
  onCorrect,
  correcting,
}: {
  item: MessageListItem;
  onCorrect: (question: Question, value: AnswerDto["value"]) => void;
  correcting: boolean;
}) {
  const [body, setBody] = useState<MessageBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBody(null);
    setError(null);
    fetchBody(item.gmailMessageId, controller.signal)
      .then(setBody)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not load this message");
      });
    // The body is dropped on every navigation, so it never accumulates.
    return () => controller.abort();
  }, [item.gmailMessageId]);

  const gmailUrl = `https://mail.google.com/mail/u/0/#all/${item.gmailMessageId}`;

  return (
    <>
      <div className="subject">{item.subject}</div>
      <div className="sender">
        {item.sender} · {new Date(item.receivedAt).toLocaleString()}
      </div>

      {item.pendingInThread > 0 && (
        <div className="banner">
          {item.pendingInThread} newer message{item.pendingInThread === 1 ? "" : "s"} in this
          thread {item.pendingInThread === 1 ? "has" : "have"} not been classified yet.
        </div>
      )}

      {item.quality === "missing_body" && (
        <div className="banner">
          This message has no readable body, so it was not classified. Open it in Gmail.
        </div>
      )}

      <ul className="why">
        {item.trayReasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <div className="answers">
        {item.answers.map((answer) => (
          <AnswerRow key={answer.question} answer={answer} />
        ))}
      </div>

      {correcting && (
        <div className="corrections">
          {item.answers.map((answer) => (
            <fieldset key={answer.question}>
              <legend>{QUESTION_LABELS[answer.question]}</legend>
              <div className="options">
                {OPTIONS[answer.question].map((option) => (
                  <button
                    key={display(option)}
                    aria-pressed={isSelected(answer, option)}
                    onClick={() => onCorrect(answer.question, option)}
                  >
                    {display(option)}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}

      {error && <div className="banner">{error}</div>}

      {body?.text ? (
        <div className="body-text">{body.text}</div>
      ) : (
        // When the body is missing, the classification banner above already says
        // so. Repeating it here read as a duplicate warning.
        body?.unavailableReason &&
        item.quality !== "missing_body" && <div className="banner">{body.unavailableReason}</div>
      )}

      <div className="actions">
        <a href={gmailUrl} target="_blank" rel="noreferrer noopener">
          Open in Gmail
        </a>
      </div>
    </>
  );
}

export function App() {
  const [tray, setTray] = useState<Tray>("needs_reply");
  const [page, setPage] = useState<MessagePage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [syncLabel, setSyncLabel] = useState<string>("idle");
  const [loading, setLoading] = useState(true);
  const reloadTimer = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listMessages(tray, null, controller.signal)
      .then(setPage)
      .catch(() => setPage(null))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [tray]);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchSyncStatus(controller.signal)
        .then((status) => setSyncLabel(status.state === "idle" ? "synced" : status.state))
        .catch(() => setSyncLabel("offline"));
    };
    poll();
    // Polling backs off and stops entirely when the tab is hidden, so a
    // backgrounded app cannot quietly burn quota.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, 30_000);
    reloadTimer.current = timer as unknown as number;
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const selected = page?.messages.find((item) => item.gmailMessageId === selectedId) ?? null;

  const onCorrect = useCallback(
    async (question: Question, value: AnswerDto["value"]) => {
      if (!selected) return;
      if (!selected.answers.some((answer) => answer.question === question)) return;
      await submitCorrection(selected.gmailMessageId, {
        gmailMessageId: selected.gmailMessageId,
        changes: [{ question, operation: "set", value }],
      });
      setCorrecting(false);
      const refreshed = await listMessages(tray, null);
      setPage(refreshed);
    },
    [selected, tray],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Jevmail</h1>
        <span className="status-pill">read-only</span>
        <span className="status-pill">automation off</span>
        <span className="spacer" />
        <span className="status-pill">{syncLabel}</span>
      </header>

      <nav className="trays" aria-label="Trays">
        {TRAY_ORDER.map((key) => (
          <button
            key={key}
            aria-current={tray === key}
            onClick={() => {
              setTray(key);
              setSelectedId(null);
            }}
          >
            {TRAY_LABELS[key]}
          </button>
        ))}
      </nav>

      <div className="panes">
        <div className="list" hidden={selected !== null}>
          {loading && <div className="empty">Loading…</div>}
          {!loading && page?.messages.length === 0 && (
            <div className="empty">Nothing here.</div>
          )}
          {page?.messages.map((item) => (
            <MessageRow
              key={item.gmailMessageId}
              item={item}
              selected={item.gmailMessageId === selectedId}
              onSelect={() => {
                setSelectedId(item.gmailMessageId);
                setCorrecting(false);
              }}
            />
          ))}
        </div>

        <div className="reader" hidden={selected === null}>
          {selected === null ? (
            <div className="empty">Select a message.</div>
          ) : (
            <>
              <button className="back" onClick={() => setSelectedId(null)}>
                ← Back
              </button>
              <Reader item={selected} onCorrect={onCorrect} correcting={correcting} />
              <div className="actions">
                {!correcting && (
                  <button onClick={() => setCorrecting(true)}>Correct a field</button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
