import type {
  ExitPlanModeInput,
  ExitPlanModeResult,
  ToolRenderer,
} from "./types";

/** Extended input type with server-rendered HTML */
interface ExitPlanModeInputWithHtml extends ExitPlanModeInput {
  _renderedHtml?: string;
}

/** Extended result type with server-rendered HTML */
interface ExitPlanModeResultWithHtml extends ExitPlanModeResult {
  _renderedHtml?: string;
}

/** Renders the plan content (markdown or plain text) */
function PlanContent({
  plan,
  renderedHtml,
}: {
  plan?: string;
  renderedHtml?: string;
}) {
  if (renderedHtml) {
    // Server-rendered HTML with shiki syntax highlighting
    // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered markdown is safe
    return <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
  }

  // Fallback to plain text when server-rendered HTML is not available
  return (
    <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{plan}</pre>
  );
}

export const exitPlanModeRenderer: ToolRenderer<
  ExitPlanModeInput,
  ExitPlanModeResult
> = {
  tool: "ExitPlanMode",

  // These are required by the interface but won't be used since renderInline takes over
  renderToolUse() {
    return null;
  },

  renderToolResult() {
    return null;
  },

  // Render inline without any tool-row wrapper - full control over rendering
  renderInline(input, result, isError, status) {
    const planInput = input as ExitPlanModeInputWithHtml;
    const planResult = result as ExitPlanModeResultWithHtml;

    // Get plan content from input (tool_use) or result (tool_result)
    const plan: string | undefined = planInput?.plan || planResult?.plan;

    // Get pre-rendered HTML from server (if available)
    const renderedHtml: string | undefined =
      planInput?._renderedHtml || planResult?._renderedHtml;

    if (isError) {
      // Result can be a plain string or an object with message field
      let errorMessage = "Exit plan mode failed";
      if (typeof result === "string") {
        errorMessage = result;
      } else if (typeof result === "object" && result !== null) {
        const errorResult = result as { message?: unknown };
        if (errorResult.message) {
          errorMessage = String(errorResult.message);
        }
      }
      return <div className="exitplan-error">{errorMessage}</div>;
    }

    // Show "Planning..." only if we don't have plan content yet
    if (!plan && !renderedHtml) {
      if (status === "pending") {
        return <div className="exitplan-pending">Planning...</div>;
      }
      return null;
    }

    // Wrap in collapsible details element - expanded by default
    // Uses the same styling as ThinkingBlock for consistency
    return (
      <details className="exitplan-collapsible collapsible" open>
        <summary className="collapsible__summary">
          <span>{status === "pending" ? "Planning..." : "Plan"}</span>
          <span className="collapsible__icon">▸</span>
        </summary>
        <div className="collapsible__content">
          <div
            className={`exitplan-inline ${status === "pending" ? "pending" : ""}`}
          >
            <PlanContent plan={plan} renderedHtml={renderedHtml} />
          </div>
        </div>
      </details>
    );
  },

  getUseSummary(_input) {
    return "Exit plan mode";
  },

  getResultSummary(_result, isError) {
    if (isError) return "Error";
    return "Plan";
  },
};
