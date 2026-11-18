import { Octokit as Core } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

// The all-in-one `octokit` package also loads the GitHub App, OAuth App and
// webhooks modules (plus retry and throttling), none of which this server
// uses. Core plus the two plugins keeps `octokit.rest.*` and
// `octokit.paginate` and skips the rest, which matters for cold start time.
export const Octokit = Core.plugin(restEndpointMethods, paginateRest);
export type Octokit = InstanceType<typeof Octokit>;
