export const UNASSIGNED_USER = '__unassigned__';

/** Map userId -> Set of teamIds from the /teams list (members included). */
export function buildUserTeamsMap(teams) {
    const map = new Map();
    for (const team of teams || []) {
        for (const member of team.members || []) {
            const uid = member.id;
            if (!uid) continue;
            if (!map.has(uid)) map.set(uid, new Set());
            map.get(uid).add(team.id);
        }
    }
    return map;
}

/** Client-side task filter by assignee, team membership, and/or project. */
export function matchesTaskFilters(
    task,
    { userIds = [], teamIds = [], projectIds = [], userTeamsMap },
) {
    if (userIds.length) {
        const key = task.assigneeId || UNASSIGNED_USER;
        if (!userIds.includes(key)) return false;
    }
    if (projectIds.length) {
        const pid = task.project?.id;
        if (!pid || !projectIds.includes(pid)) return false;
    }
    if (teamIds.length) {
        if (!task.assigneeId) return false;
        const userTeams = userTeamsMap?.get(task.assigneeId);
        if (!userTeams || !teamIds.some((tid) => userTeams.has(tid))) {
            return false;
        }
    }
    return true;
}
