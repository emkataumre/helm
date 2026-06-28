// src/shared/types.ts
export type TaskStatus = "queued" | "running" | "merged" | "needs-human" | "abandoned";

export interface Project {
    id: string;
    name: string;
    repoPath: string;
    integrationBranch: string; // default "integration/ralph"
    targetBranch: string;      // branch integration is created from AND promoted into
    branchPrefix: string;      // default "ralph" -> task branches "ralph/task-<id>"
    checkCommand: string;      // mandatory; the Layer-A gate
    worktreeDir: string;       // relative to repoPath; default ".helm/worktrees"
}

export interface Task {
    id: string;
    projectId: string;
    title: string;
    intent: string;            // prose directive (what to build)
    acceptance: string[];      // executable proof commands (stored now; run from M2)
    status: TaskStatus;
    branchName: string | null;
    worktreePath: string | null;
    diffstat: string | null;
    failureReason: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface Iteration {
    id: string;
    taskId: string;
    index: number;
    sessionId: string | null;  // captured from M3 (stream-json)
    startedAt: number;
    endedAt: number | null;
    gateVerdict: "green" | "failed" | "hang" | null;
    commitSha: string | null;
    outputTail: string | null;
}

// IPC contract: the renderer calls these; main implements them.
export interface NewProjectInput {
    name: string;
    repoPath: string;
    targetBranch: string;
    checkCommand: string;
}
export interface NewTaskInput {
    projectId: string;
    title: string;
    intent: string;
    acceptance: string[];
}
export interface HelmApi {
    registerProject: (input: NewProjectInput) => Promise<Project>;
    listProjects: () => Promise<Project[]>;
    createTask: (input: NewTaskInput) => Promise<Task>;
    listTasks: () => Promise<Task[]>;
    runTask: (taskId: string) => Promise<TaskStatus>;
    onTasksChanged: (cb: () => void) => void;
}
