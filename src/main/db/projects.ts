// src/main/db/projects.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Project, NewProjectInput } from "../../shared/types";

export function insertProject(db: Db, input: NewProjectInput): Project {
    const p: Project = {
        id: randomUUID(),
        name: input.name,
        repoPath: input.repoPath,
        integrationBranch: "integration/ralph",
        targetBranch: input.targetBranch,
        branchPrefix: "ralph",
        checkCommand: input.checkCommand,
        worktreeDir: ".helm/worktrees",
    };
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (@id,@name,@repoPath,@integrationBranch,@targetBranch,@branchPrefix,@checkCommand,@worktreeDir)`,
    ).run(p);
    return p;
}

export function listProjects(db: Db): Project[] {
    return db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
}

export function getProject(db: Db, id: string): Project | undefined {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}
