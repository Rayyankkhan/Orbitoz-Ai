/**
 * Domain parsers: the shapes a workflow actually asks a model for.
 *
 * The generic `parseStructuredOutput` in `engine/` knows how to extract and
 * validate *any* schema. These files are where the schemas live — content
 * generation and workflow decisions — so a caller composes a request without
 * re-declaring the same JSON Schema at every call site and without forgetting
 * the semantic checks a schema cannot express.
 */
export {
  CONTENT_GENERATION_SCHEMA,
  parseContentGeneration,
  type GeneratedContent,
  type ParsedContentGeneration,
} from './content.js';

export {
  isWorkflowDecision,
  parseWorkflowDecision,
  WORKFLOW_DECISION_SCHEMA,
  WORKFLOW_DECISIONS,
  type ParsedWorkflowDecision,
  type WorkflowDecision,
  type WorkflowDecisionKind,
} from './decision.js';
