import { getInput, setFailed } from '@actions/core';
import { context, getOctokit } from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';

async function run() {
  try {
    const token = getInput('gh-token');
    const targetLabel = getInput('label') || 'tech-radar';
    const targetDirectory = getInput('target-directory') || 'radar';
    
    // Exit if not an issue closure event
    if (context.eventName !== 'issues' || context.payload.action !== 'closed') {
      console.log('This action only runs on issue closed events');
      return;
    }
    
    const issue = context.payload.issue;
    
    // Check if the issue has the tech-radar label
    if (!issue || !issue.labels.some((label: any) => label.name === targetLabel)) {
      console.log(`Issue does not have the required "${targetLabel}" label`);
      return;
    }
    
    console.log(`Processing tech radar entry from issue #${issue.number}: ${issue.title}`);
    
    const octokit = getOctokit(token);
    
    // Get the issue content
    const issueContent = issue.body || '';
    
    // Create a filename based on issue title and number
    const safeTitle = issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    const filename = `${safeTitle}-${issue.number}.md`;
    const filepath = path.join(targetDirectory, filename);
    
    // Format the content with some metadata
    const formattedContent = `# ${issue.title}\n\n` +
      `> From issue [#${issue.number}](${issue.html_url}) by [@${issue.user.login}](${issue.user.html_url})\n\n` +
      `${issueContent}\n`;
    
    // Get the default branch
    const { data: repoData } = await octokit.rest.repos.get({
      owner: context.repo.owner,
      repo: context.repo.repo
    });
    
    const defaultBranch = repoData.default_branch;
    
    try {
      // Check if file already exists
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: filepath,
        ref: defaultBranch
      });
      
      // Update existing file
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: filepath,
        message: `Update tech radar entry from issue #${issue.number}`,
        content: Buffer.from(formattedContent).toString('base64'),
        branch: defaultBranch,
        sha: (fileData as any).sha
      });
      
    } catch (e) {
      // File doesn't exist, create it
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: filepath,
        message: `Add tech radar entry from issue #${issue.number}`,
        content: Buffer.from(formattedContent).toString('base64'),
        branch: defaultBranch
      });
    }
    
    console.log(`Successfully created tech radar entry at ${filepath}`);
    
  } catch (error) {
    console.error(error);
    setFailed((error as Error)?.message ?? 'Unknown error');
  }
}

run();


