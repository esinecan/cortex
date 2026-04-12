/**
 * User and team tools: get_me, get_teams, get_team_members
 */

import { execGhApi } from "../core/executor.js";
import type { GetTeamMembersInput, GetTeamsInput } from "../core/types.js";

export async function getMe(): Promise<unknown> {
  return execGhApi<unknown>("/user");
}

export async function getTeams(args: Record<string, unknown>): Promise<unknown> {
  const { user } = args as unknown as GetTeamsInput;
  
  // If user specified, get their orgs' teams (limited API access)
  // Otherwise, get authenticated user's teams
  if (user) {
    // There's no direct endpoint for another user's teams
    // Best we can do is get orgs they belong to
    return execGhApi<unknown>(`/users/${user}/orgs`);
  }
  
  return execGhApi<unknown>("/user/teams");
}

export async function getTeamMembers(args: Record<string, unknown>): Promise<unknown> {
  const { org, team_slug } = args as unknown as GetTeamMembersInput;

  if (!org || !team_slug) {
    throw new Error("org and team_slug are required");
  }

  return execGhApi<unknown>(`/orgs/${org}/teams/${team_slug}/members`);
}
