/** STUB — WordPress REST API: read pages/posts, publish pages/posts. */
import type { Site, PublishProfile } from '../model/site';

export async function publishToWordPress(site: Site, profile: PublishProfile, paths: string[], password: string, log: (line: string) => void): Promise<number> {
  void site; void profile; void paths; void password; void log;
  throw new Error('Not implemented yet');
}
