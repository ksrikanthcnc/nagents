/**
 * Hook Translation Tests (kiro_translate.py)
 *
 * Tests the Python translate() function by spawning it as a subprocess.
 * This is the data pipeline — hooks fire, translate converts to EventUpdate.
 *
 * We call the Python functions directly via uv run.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { resolve } from "path";

const PROJECT_ROOT = resolve(__dirname, "..");
const TRANSLATE_PATH = resolve(PROJECT_ROOT, "sources/kiro_translate.py");

/** Call a Python function from kiro_translate.py and return the result. */
function callTranslate(trigger: string, payload: object, sessionId: string): any {
  const script = [
    "import sys, json",
    `sys.path.insert(0, '${PROJECT_ROOT}/sources')`,
    "from kiro_translate import translate",
    `result = translate(${JSON.stringify(trigger)}, json.loads(${JSON.stringify(JSON.stringify(payload))}), ${JSON.stringify(sessionId)})`,
    "print(json.dumps(result))",
  ].join("\n");
  const scriptFile = resolve(PROJECT_ROOT, "tests/.tmp_translate_call.py");
  const { writeFileSync, unlinkSync } = require("fs");
  writeFileSync(scriptFile, script);
  try {
    const output = execSync(`python3 ${scriptFile}`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return JSON.parse(output);
  } finally {
    try { unlinkSync(scriptFile); } catch {}
  }
}

/** Call a helper function from kiro_translate.py */
function callHelper(funcName: string, ...args: any[]): any {
  const argsStr = args.map(a => JSON.stringify(a)).join(", ");
  const script = [
    "import sys, json",
    `sys.path.insert(0, '${PROJECT_ROOT}/sources')`,
    `from kiro_translate import ${funcName}`,
    `result = ${funcName}(${argsStr})`,
    "print(json.dumps(result))",
  ].join("\n");
  const scriptFile = resolve(PROJECT_ROOT, "tests/.tmp_helper_call.py");
  const { writeFileSync, unlinkSync } = require("fs");
  writeFileSync(scriptFile, script);
  try {
    const output = execSync(`python3 ${scriptFile}`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return JSON.parse(output);
  } finally {
    try { unlinkSync(scriptFile); } catch {}
  }
}

describe("translate() — PreToolUse", () => {
  it("read_file → event=tool with file path", () => {
    const result = callTranslate("PreToolUse", {
      tool_name: "read_file",
      tool_input: { path: "/Users/user/work/git/repo/src/main.ts" },
    }, "test-session-001");

    expect(result.session_id).toBe("test-session-001");
    expect(result.event).toBe("tool");
    expect(result.tool).toBe("read_file");
    expect(result.file).toContain("main.ts");
  });

  it("execute_bash → file shows command summary", () => {
    const result = callTranslate("PreToolUse", {
      tool_name: "execute_bash",
      tool_input: { command: "git status && npm test" },
    }, "test-session-001");

    expect(result.event).toBe("tool");
    expect(result.tool).toBe("execute_bash");
    expect(result.file).toContain("git");
    expect(result.file).toContain("npm");
  });

  it("invoke_sub_agent → worker spawn (+name)", () => {
    const result = callTranslate("PreToolUse", {
      tool_name: "invoke_sub_agent",
      tool_input: { name: "context-gatherer", prompt: "Explore auth flow in the codebase" },
    }, "test-session-001");

    expect(result.event).toBe("tool");
    expect(result.worker).toContain("+cg");
    expect(result.worker).toContain("Explore auth flow");
  });

  it("unknown tool → tool=unknown", () => {
    const result = callTranslate("PreToolUse", {
      tool_name: "",
      tool_input: {},
    }, "test-session-001");

    expect(result.event).toBe("tool");
    expect(result.tool).toBe("unknown");
  });
});

describe("translate() — PostToolUse", () => {
  it("generic post → event=running, clears tool/file", () => {
    const result = callTranslate("PostToolUse", {
      tool_name: "read_file",
      tool_input: { path: "src/main.ts" },
    }, "test-session-001");

    expect(result.event).toBe("running");
    expect(result.tool).toBe("");
    expect(result.file).toBe("");
  });

  it("invoke_sub_agent post → worker done (-name)", () => {
    const result = callTranslate("PostToolUse", {
      tool_name: "invoke_sub_agent",
      tool_input: { name: "context-gatherer" },
    }, "test-session-001");

    expect(result.worker).toBe("-cg");
  });

  it("execute_bash exit 0 → tool_ok=true", () => {
    const result = callTranslate("PostToolUse", {
      tool_name: "execute_bash",
      tool_input: { command: "npm test" },
      tool_response: "All tests passed\n\nExit Code: 0",
    }, "test-session-001");

    expect(result.tool_ok).toBe(true);
  });

  it("execute_bash exit 1 → tool_ok=false", () => {
    const result = callTranslate("PostToolUse", {
      tool_name: "execute_bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL src/test.ts\n\nExit Code: 1",
    }, "test-session-001");

    expect(result.tool_ok).toBe(false);
  });

  it("todo_list → parses progress", () => {
    const todoResponse = JSON.stringify({
      tasks: [
        { task_description: "Setup project", completed: true },
        { task_description: "Write tests", completed: true },
        { task_description: "Fix bugs", completed: false },
        { task_description: "Deploy", completed: false },
      ],
    });

    const result = callTranslate("PostToolUse", {
      tool_name: "todo_list",
      tool_input: { command: "list" },
      tool_response: todoResponse,
    }, "test-session-001");

    expect(result.tool_result).toBe("2/4: Fix bugs");
  });

  it("update_session_information → description + action_text", () => {
    const result = callTranslate("PostToolUse", {
      tool_name: "update_session_information",
      tool_input: { description: "Working on auth refactor", status: "in_progress" },
    }, "test-session-001");

    expect(result.description).toBe("Working on auth refactor");
    expect(result.action_text).toBe("Working on auth refactor");
    expect(result.status).toBe("in_progress");
  });

  it("update_session_information with waiting_on_user → ? prefix", () => {
    const result = callTranslate("PostToolUse", {
      tool_name: "update_session_information",
      tool_input: { description: "Waiting on user: which approach?", status: "waiting_on_user" },
    }, "test-session-001");

    // clean_description strips "Waiting on user: " prefix
    expect(result.action_text).toContain("?");
    expect(result.action_text).toContain("which approach?");
    expect(result.status).toBe("waiting_on_user");
  });
});

describe("translate() — Stop", () => {
  it("Stop → idle, clears fields", () => {
    const result = callTranslate("Stop", {}, "test-session-001");

    expect(result.session_id).toBe("test-session-001");
    expect(result.event).toBe("idle");
    expect(result.priority).toBe("low");
    expect(result.tool).toBe("");
    expect(result.file).toBe("");
    expect(result.tool_result).toBe("");
    expect(result.action_text).toBe("");
  });
});

describe("translate() — UserPromptSubmit", () => {
  it("basic prompt → running, stores prompt, clears stale", () => {
    const result = callTranslate("UserPromptSubmit", {
      prompt: "fix the login bug",
    }, "test-session-001");

    expect(result.event).toBe("running");
    expect(result.prompt).toBe("fix the login bug");
    expect(result.tool).toBe("");
    expect(result.file).toBe("");
    expect(result.tool_result).toBe("");
    expect(result.description).toBe("");
    expect(result.action_text).toBe("");
  });

  it("empty session_id returns None", () => {
    const result = callTranslate("UserPromptSubmit", { prompt: "test" }, "");
    expect(result).toBeNull();
  });
});

describe("translate() — nagents: command", () => {
  it("parses nagents command from prompt", () => {
    const result = callTranslate("UserPromptSubmit", {
      prompt: "nagents:sess_ca95a60c:k8s:deploy-monitor",
    }, "test-session-001");

    expect(result._nagents_cmd).toBe(true);
    expect(result.title).toBe("deploy-monitor");
    expect(result.group).toBe("k8s");
  });
});

describe("Helper: parse_exit_code", () => {
  it("parses exit 0", () => {
    expect(callHelper("parse_exit_code", "output\n\nExit Code: 0")).toBe(true);
  });

  it("parses exit 1", () => {
    expect(callHelper("parse_exit_code", "Error\n\nExit Code: 1")).toBe(false);
  });

  it("parses exit 127", () => {
    expect(callHelper("parse_exit_code", "not found\nExit Code: 127")).toBe(false);
  });

  it("returns null for missing exit code", () => {
    expect(callHelper("parse_exit_code", "just some output")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(callHelper("parse_exit_code", "")).toBeNull();
  });
});

describe("Helper: shorten_agent_name", () => {
  it("shortens known agents", () => {
    expect(callHelper("shorten_agent_name", "context-gatherer")).toBe("cg");
    expect(callHelper("shorten_agent_name", "general-task-execution")).toBe("task");
    expect(callHelper("shorten_agent_name", "semantic_reviewer")).toBe("reviewer");
  });

  it("returns unknown agents as-is", () => {
    expect(callHelper("shorten_agent_name", "my-custom-agent")).toBe("my-custom-agent");
  });
});

describe("Helper: shorten_path", () => {
  it("shortens home path", () => {
    const result = callHelper("shorten_path", `${process.env.HOME}/work/git/repo/src/main.ts`);
    expect(result).not.toContain(process.env.HOME!);
    expect(result).toContain("main.ts");
  });

  it("returns null for null input", () => {
    // Python None = JSON null, need special handling
    const script = [
      "import sys, json",
      `sys.path.insert(0, '${resolve(__dirname, "../sources")}')`,
      "from kiro_translate import shorten_path",
      "result = shorten_path(None)",
      "print(json.dumps(result))",
    ].join("\n");
    const scriptFile = resolve(__dirname, ".tmp_null_test.py");
    const { writeFileSync, unlinkSync } = require("fs");
    writeFileSync(scriptFile, script);
    try {
      const output = execSync(`python3 ${scriptFile}`, { encoding: "utf-8", timeout: 5000 }).trim();
      expect(JSON.parse(output)).toBeNull();
    } finally {
      try { unlinkSync(scriptFile); } catch {}
    }
  });
});
