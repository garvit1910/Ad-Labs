/*
 * A5's text-only creative worker. A6's Copywriter (app/api/agent/creatives)
 * calls runGenerateCreatives(taskId, { claimedBy: 'copywriter' }); the worker
 * loop (npm run a5:creatives -- worker) calls it for tasks the Copywriter
 * leaves unclaimed for a minute.
 */
export { runCreativeTaskLoop, type CreativeLoopOptions } from './loop';
export {
  CREATIVE_WORKER,
  ClaimLostError,
  failTask,
  runGenerateCreatives,
  runRound0,
  type TaskResult,
} from './run';
export { NotReadyError } from './inputs';
