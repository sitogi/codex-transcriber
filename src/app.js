import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const h = React.createElement;

const DEFAULT_SESSIONS_DIR =
  process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions");

const EXCLUDE_PREFIXES = [
  "# AGENTS.md",
  "<environment_context>",
  "<permissions instructions>",
  "<INSTRUCTIONS>",
];

function shouldExcludeText(text) {
  if (!text) return true;
  const trimmed = text.trimStart();
  return EXCLUDE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

async function findJsonlFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findJsonlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function readFirstLine(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    stream.destroy();
    return line.trim();
  }
  return "";
}

function parseTimestampFromFilename(filePath) {
  const name = path.basename(filePath);
  const match = name.match(
    /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/u,
  );
  if (!match) return null;
  const datePart = match[1];
  const timePart = `${match[2]}:${match[3]}:${match[4]}Z`;
  const iso = `${datePart}T${timePart}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").replace("Z", "Z");
}

async function readSessionMeta(filePath) {
  try {
    const line = await readFirstLine(filePath);
    if (!line) return null;
    const parsed = JSON.parse(line);
    if (parsed?.type === "session_meta") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").replace("Z", "Z");
}

function buildSessionLabel(meta, filePath, baseDir) {
  const tsRaw = meta?.payload?.timestamp || meta?.timestamp;
  const ts = formatTimestamp(tsRaw) || parseTimestampFromFilename(filePath);
  if (ts) return ts;
  return path.relative(baseDir, filePath);
}

function truncateLabel(label, maxWidth) {
  if (!label) return "";
  if (label.length <= maxWidth) return label;
  if (maxWidth <= 3) return label.slice(0, maxWidth);
  return `${label.slice(0, maxWidth - 3)}...`;
}

function charWidth(char) {
  const code = char.codePointAt(0) || 0;
  if (code <= 0x1f) return 0;
  if (code <= 0x7f) return 1;
  return 2;
}

function wrapText(text, maxWidth) {
  if (maxWidth <= 0) return [text || ""];
  if (text === "") return [" "];
  const lines = [];
  let line = "";
  let lineWidth = 0;
  for (const char of text || "") {
    if (char === "\r") continue;
    if (char === "\t") {
      const tab = "  ";
      for (const tabChar of tab) {
        const width = charWidth(tabChar);
        if (lineWidth + width > maxWidth && line !== "") {
          lines.push(line);
          line = "";
          lineWidth = 0;
        }
        line += tabChar;
        lineWidth += width;
        if (lineWidth >= maxWidth) {
          lines.push(line);
          line = "";
          lineWidth = 0;
        }
      }
      continue;
    }
    const width = charWidth(char);
    if (lineWidth + width > maxWidth && line !== "") {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += char;
    lineWidth += width;
    if (lineWidth >= maxWidth) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
  }
  if (line !== "" || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}

function wrapRows(rows, maxWidth) {
  const wrapped = [];
  for (const row of rows) {
    const lines = wrapText(row.text || "", maxWidth);
    if (lines.length === 0) {
      wrapped.push(row);
      continue;
    }
    lines.forEach((line, index) => {
      const nextType =
        index === 0 ? row.type : row.type === "label" ? "text" : row.type;
      wrapped.push({ ...row, type: nextType, text: line });
    });
  }
  return wrapped;
}

function imagePlaceholders(payload) {
  const images = [];
  if (Array.isArray(payload?.images)) images.push(...payload.images);
  if (Array.isArray(payload?.local_images)) images.push(...payload.local_images);
  if (images.length === 0) return [];
  return images.map((_, index) => `[image ${index + 1}]`);
}

function appendImages(text, payload) {
  const placeholders = imagePlaceholders(payload);
  if (placeholders.length === 0) return text;
  const suffix = placeholders.join("\n");
  if (!text) return suffix;
  return `${text}\n\n${suffix}`;
}

function buildTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = content
    .filter(
      (item) => item?.type === "input_text" || item?.type === "output_text",
    )
    .map((item) => item.text)
    .filter(Boolean);
  return parts.join("\n");
}

async function extractConversation(filePath) {
  const eventMessages = [];
  const fallbackMessages = [];

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed?.type === "event_msg") {
      const payload = parsed.payload || {};
      const msgType = payload.type;
      if (msgType === "user_message") {
        const text = appendImages(payload.message || "", payload);
        if (!shouldExcludeText(text)) {
          eventMessages.push({ role: "user", text });
        }
      }
      if (msgType === "agent_message" || msgType === "assistant_message") {
        const text = payload.message || "";
        if (!shouldExcludeText(text)) {
          eventMessages.push({ role: "assistant", text });
        }
      }
    }

    if (parsed?.type === "response_item") {
      const payload = parsed.payload || {};
      if (payload.type === "message") {
        const role = payload.role;
        if (role === "user" || role === "assistant") {
          const text = buildTextFromContent(payload.content);
          if (!shouldExcludeText(text)) {
            fallbackMessages.push({ role, text });
          }
        }
      }
    }
  }

  if (eventMessages.length > 0) return eventMessages;
  return fallbackMessages;
}

function buildMarkdown(entries) {
  const blocks = entries.map((entry) => {
    const header = entry.role === "user" ? "### User" : "### Assistant";
    const body = entry.text || "";
    return `${header}\n${body}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

function buildPrettyRows(entries) {
  const rows = [];
  for (const entry of entries) {
    const label = entry.role === "user" ? "User" : "Assistant";
    rows.push({ type: "label", role: entry.role, text: label });
    const lines = (entry.text || "").split("\n");
    if (lines.length === 0) {
      rows.push({ type: "text", role: entry.role, text: " " });
    } else {
      for (const line of lines) {
        rows.push({
          type: "text",
          role: entry.role,
          text: line === "" ? " " : line,
        });
      }
    }
    rows.push({ type: "spacer", text: " " });
    rows.push({ type: "spacer", text: " " });
  }
  while (rows.length && rows[rows.length - 1].type === "spacer") {
    rows.pop();
  }
  return rows;
}

function buildMarkdownRows(markdown) {
  if (!markdown) return [];
  return markdown
    .split("\n")
    .map((line) => ({ type: "text", text: line === "" ? " " : line }));
}

function defaultExportPath(session) {
  const base =
    session?.id || path.basename(session.path || "session", ".jsonl");
  return path.join(process.cwd(), `${base}.md`);
}

function ListView({
  sessions,
  loading,
  error,
  selectedIndex,
  scrollOffset,
  visibleCount,
  maxLabelWidth,
}) {
  if (loading) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "読み込み 中"),
    );
  }

  if (error) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "読み込み エラー"),
      h(Text, null, error),
    );
  }

  if (!sessions.length) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "セッション が 見つかりません"),
    );
  }

  const visibleSessions = sessions.slice(scrollOffset, scrollOffset + visibleCount);

  return h(
    Box,
    { flexDirection: "column" },
    h(Box, { flexDirection: "column" }, [
      ...visibleSessions.map((session, index) => {
        const actualIndex = scrollOffset + index;
        const prefix = actualIndex === selectedIndex ? "> " : "  ";
        const label = truncateLabel(session.label, maxLabelWidth);
        return h(
          Text,
          {
            key: session.path,
            color: actualIndex === selectedIndex ? "cyan" : undefined,
            wrap: "truncate",
          },
          `${prefix}${label}`,
        );
      }),
    ]),
  );
}

function ConversationView({
  session,
  loading,
  error,
  rows,
  scrollOffset,
  visibleCount,
}) {
  if (loading) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "読み込み 中"),
    );
  }

  if (error) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "読み込み エラー"),
      h(Text, null, error),
    );
  }

  const visibleRows = rows.slice(scrollOffset, scrollOffset + visibleCount);

  return h(
    Box,
    { flexDirection: "column" },
    !session
      ? h(Text, { marginTop: 1 }, "セッション を 選択")
      : !rows.length
        ? h(Text, { marginTop: 1 }, "会話 が ありません")
      : h(
          Box,
          { flexDirection: "column" },
          visibleRows.map((row, index) => {
            if (row.type === "label") {
              const color = row.role === "user" ? "cyan" : "green";
              return h(Text, { key: index, color }, row.text);
            }
            return h(Text, { key: index }, row.text);
          }),
        ),
  );
}

export default function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [sessions, setSessions] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState("");

  const [selectedSession, setSelectedSession] = useState(null);

  const [conversation, setConversation] = useState([]);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [conversationError, setConversationError] = useState("");

  const [viewMode, setViewMode] = useState("pretty");
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState("");
  const [status, setStatus] = useState("");
  const [statusDetail, setStatusDetail] = useState("");
  const [rightScrollOffset, setRightScrollOffset] = useState(0);
  const [focus, setFocus] = useState("left");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoadingSessions(true);
      setSessionsError("");
      try {
        const files = await findJsonlFiles(DEFAULT_SESSIONS_DIR);
        const sessionsData = await Promise.all(
          files.map(async (filePath) => {
            const meta = await readSessionMeta(filePath);
            const label = buildSessionLabel(
              meta,
              filePath,
              DEFAULT_SESSIONS_DIR,
            );
            const id = meta?.payload?.id || null;
            const tsRaw = meta?.payload?.timestamp || meta?.timestamp;
            const ts = tsRaw ? Date.parse(tsRaw) : 0;
            return {
              id,
              label,
              path: filePath,
              sortKey: Number.isNaN(ts) ? 0 : ts,
            };
          }),
        );
        sessionsData.sort((a, b) => {
          if (a.sortKey && b.sortKey && a.sortKey !== b.sortKey) {
            return b.sortKey - a.sortKey;
          }
          return a.label.localeCompare(b.label);
        });
        if (!cancelled) {
          setSessions(sessionsData);
          setSelectedIndex(0);
          setScrollOffset(0);
        }
      } catch (error) {
        if (!cancelled) {
          setSessionsError(error?.message || String(error));
        }
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const session = sessions[selectedIndex] || null;
    setSelectedSession(session);
  }, [sessions, selectedIndex]);

  const paneHeight = useMemo(() => {
    const rows = stdout?.rows || 24;
    const headerLines = 10;
    return Math.max(4, rows - headerLines);
  }, [stdout?.rows]);

  const visibleCount = useMemo(() => {
    return Math.max(1, paneHeight - 2);
  }, [paneHeight]);

  const leftWidth = useMemo(() => {
    const columns = stdout?.columns || 120;
    const computed = Math.floor(columns * 0.2);
    return Math.min(32, Math.max(18, computed));
  }, [stdout?.columns]);

  const leftContentWidth = useMemo(() => {
    return Math.max(10, leftWidth - 2);
  }, [leftWidth]);

  const rightContentWidth = useMemo(() => {
    const columns = stdout?.columns || 120;
    const rightPaneWidth = Math.max(20, columns - leftWidth);
    return Math.max(10, rightPaneWidth - 2);
  }, [stdout?.columns, leftWidth]);

  const maxLabelWidth = useMemo(() => {
    return Math.max(8, leftContentWidth - 2);
  }, [leftContentWidth]);

  useEffect(() => {
    if (!sessions.length) return;
    const maxOffset = Math.max(0, sessions.length - visibleCount);
    setScrollOffset((prev) => {
      let next = prev;
      if (selectedIndex < next) next = selectedIndex;
      if (selectedIndex >= next + visibleCount) {
        next = selectedIndex - visibleCount + 1;
      }
      if (next > maxOffset) next = maxOffset;
      if (next < 0) next = 0;
      return next;
    });
  }, [selectedIndex, sessions.length, visibleCount]);

  useEffect(() => {
    if (!selectedSession) {
      setConversation([]);
      setConversationError("");
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoadingConversation(true);
      setConversationError("");
      setConversation([]);
      try {
        const entries = await extractConversation(selectedSession.path);
        if (!cancelled) {
          setConversation(entries);
          setRightScrollOffset(0);
        }
      } catch (error) {
        if (!cancelled) {
          setConversationError(error?.message || String(error));
        }
      } finally {
        if (!cancelled) setLoadingConversation(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [selectedSession]);

  const markdown = useMemo(
    () => buildMarkdown(conversation),
    [conversation],
  );

  const prettyRows = useMemo(
    () => buildPrettyRows(conversation),
    [conversation],
  );
  const markdownRows = useMemo(
    () => buildMarkdownRows(markdown),
    [markdown],
  );
  const conversationRows = viewMode === "markdown" ? markdownRows : prettyRows;
  const wrappedRows = useMemo(
    () => wrapRows(conversationRows, rightContentWidth),
    [conversationRows, rightContentWidth],
  );
  const rightTotalCount = wrappedRows.length;
  const maxRightOffset = Math.max(0, rightTotalCount - visibleCount);

  const leftTotalCount = sessions.length;
  const leftStartIndex = leftTotalCount
    ? Math.min(leftTotalCount, scrollOffset + 1)
    : 0;
  const leftEndIndex = Math.min(leftTotalCount, scrollOffset + visibleCount);
  const rightStartIndex = rightTotalCount
    ? Math.min(rightTotalCount, rightScrollOffset + 1)
    : 0;
  const rightEndIndex = Math.min(rightTotalCount, rightScrollOffset + visibleCount);

  useEffect(() => {
    setRightScrollOffset((prev) => Math.min(prev, maxRightOffset));
  }, [maxRightOffset]);

  useEffect(() => {
    setRightScrollOffset(0);
  }, [selectedSession, viewMode, rightContentWidth]);

  const handleExportSubmit = async () => {
    try {
      await fs.promises.writeFile(exportPath, markdown, "utf8");
      setStatus("export 完了");
      setStatusDetail(exportPath);
    } catch (error) {
      setStatus("export 失敗");
      setStatusDetail(error?.message || String(error));
    } finally {
      setExporting(false);
    }
  };

  useInput((input, key) => {
    if (exporting) {
      if (key.escape) {
        setExporting(false);
        setStatus("export キャンセル");
        setStatusDetail("");
        return;
      }
      if (key.return) {
        handleExportSubmit();
        return;
      }
      if (key.backspace || key.delete) {
        setExportPath((prev) => prev.slice(0, -1));
        return;
      }
      if (input) {
        setExportPath((prev) => `${prev}${input}`);
      }
      return;
    }

    if (key.tab) {
      setFocus((prev) => (prev === "left" ? "right" : "left"));
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (focus === "left") {
      if (key.upArrow || input === "k") {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
        return;
      }
      if (input === "g") {
        setSelectedIndex(0);
        return;
      }
      if (input === "G") {
        setSelectedIndex(Math.max(0, sessions.length - 1));
        return;
      }
    }

    if (focus === "right") {
      if (key.upArrow || input === "k") {
        setRightScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setRightScrollOffset((prev) =>
          Math.min(maxRightOffset, prev + 1),
        );
        return;
      }
      if (key.pageUp) {
        setRightScrollOffset((prev) => Math.max(0, prev - visibleCount));
        return;
      }
      if (key.pageDown) {
        setRightScrollOffset((prev) =>
          Math.min(maxRightOffset, prev + visibleCount),
        );
        return;
      }
      if (key.ctrl && input === "u") {
        setRightScrollOffset((prev) =>
          Math.max(0, prev - Math.ceil(visibleCount / 2)),
        );
        return;
      }
      if (key.ctrl && input === "d") {
        setRightScrollOffset((prev) =>
          Math.min(maxRightOffset, prev + Math.ceil(visibleCount / 2)),
        );
        return;
      }
      if (input === "g") {
        setRightScrollOffset(0);
        return;
      }
      if (input === "G") {
        setRightScrollOffset(maxRightOffset);
        return;
      }
    }
    if (input === "m") {
      setViewMode((prev) => (prev === "pretty" ? "markdown" : "pretty"));
      return;
    }
    if (input === "e") {
      const nextPath = defaultExportPath(selectedSession);
      setExportPath(nextPath);
      setExporting(true);
      setStatus("");
      setStatusDetail("");
    }
  });

  const statusLine = status || "";
  const statusDetailLine = statusDetail || "";
  const exportLine = exporting ? `出力 先 パス: ${exportPath}` : "";
  const exportHintLine = exporting ? "Enter で 保存, Esc で キャンセル" : "";

  return h(
    React.Fragment,
    null,
    h(
      Box,
      { flexDirection: "column" },
      h(Text, { wrap: "truncate" }, "Codex Transcriber"),
      h(
        Text,
        { wrap: "truncate" },
        `ディレクトリ: ${DEFAULT_SESSIONS_DIR}`,
      ),
      h(
        Text,
        { wrap: "truncate" },
        `フォーカス: ${focus === "left" ? "左" : "右"} | Tab で 切替 | q で 終了`,
      ),
      h(
        Text,
        { wrap: "truncate" },
        `左: ${leftStartIndex}-${leftEndIndex} / ${leftTotalCount} | j/k, g/G`,
      ),
      h(
        Text,
        { wrap: "truncate" },
        `右: ${rightStartIndex}-${rightEndIndex} / ${rightTotalCount} | j/k, g/G, PgUp/PgDn | m で Markdown | e で export`,
      ),
      h(Text, { wrap: "truncate" }, statusLine),
      h(Text, { wrap: "truncate" }, statusDetailLine),
      h(Text, { wrap: "truncate" }, exportLine),
      h(Text, { wrap: "truncate" }, exportHintLine),
      h(Text, null, ""),
    ),
    h(
      Box,
      { flexDirection: "row" },
      h(
        Box,
        {
          flexDirection: "column",
          borderStyle: "single",
          width: leftWidth,
          height: paneHeight,
          borderColor: focus === "left" ? "cyan" : undefined,
        },
        h(ListView, {
          sessions,
          loading: loadingSessions,
          error: sessionsError,
          selectedIndex,
          scrollOffset,
          visibleCount,
          maxLabelWidth,
        }),
      ),
      h(
        Box,
        {
          flexDirection: "column",
          borderStyle: "single",
          flexGrow: 1,
          height: paneHeight,
          borderColor: focus === "right" ? "green" : undefined,
        },
        h(ConversationView, {
          session: selectedSession,
          loading: loadingConversation,
          error: conversationError,
          rows: wrappedRows,
          scrollOffset: rightScrollOffset,
          visibleCount,
        }),
      ),
    ),
  );
}
