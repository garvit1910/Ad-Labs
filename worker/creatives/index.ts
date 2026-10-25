/*
 * A5's text-only creative worker. A6's Copywriter (app/api/agent/creatives)
 * calls runGenerateCreatives(taskId, { claimedBy: 'copywriter' }); it claims,
 * writes, queues the next run_round and completes the task itself, and on a throw
 * the caller calls failTask(spacetime, taskId, error, 'copywriter'). The worker
 * loop (npm run a5:creatives -- worker) answers tasks the Copywriter leaves
 * unclaimed for a minute, and takes over claims left untouched for 15. Before
 * anyone queues round 0, roundZeroStatus must be complete.
 */
export { runCreativeTaskLoop, type CreativeLoopOptions } from './loop';
export {
  CREATIVE_WORKER,
  ClaimLostError,
  failTask,
  roundZeroStatus,
  runGenerateCreatives,
  runRound0,
  type RoundZeroStatus,
  type TaskOptions,
  type TaskResult,
} from './run';
export { NotReadyError } from './inputs';
