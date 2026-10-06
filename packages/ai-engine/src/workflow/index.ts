/**
 * Workflow definitions, validation, and execution.
 *
 * Separate entry point so a tenant using a single model call can depend on the
 * routing and failover layers without importing the DAG executor.
 */

export {
  validateWorkflow,
  WorkflowDefinitionError,
  type AgentNode,
  type BranchNode,
  type OutputNode,
  type TransformNode,
  type WorkflowData,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowProblem,
} from './definition.js';

export {
  evaluateBranch,
  WorkflowEngine,
  templates,
  type AgentExecutionContext,
  type NodeResult,
  type WorkflowEngineOptions,
  type WorkflowRunResult,
  type WorkflowScope,
} from './executor.js';
