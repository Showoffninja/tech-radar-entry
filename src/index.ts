import { getInput, setFailed } from '@actions/core';
import { context, getOctokit } from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';

// Helper function to extract data from issue body form
function extractFormData(body: string): Record<string, string> {
  const data: Record<string, string> = {};
  
  // Pattern to match form fields like "### Technology Name\n\nKubernetes"
  const pattern = /### ([^\n]+)\s*\n\s*(?:<!--.+?-->\s*\n\s*)?(.*?)(?=\n\s*###|$)/gs;
  let match;
  
  while ((match = pattern.exec(body)) !== null) {
    const key = match[1].trim();
    const value = match[2].trim();
    
    // Convert keys to our expected format
    switch (key) {
      case "Technology Name":
        data.title = value;
        break;
      case "Ring":
        data.ring = value.toLowerCase();
        break;
      case "Quadrant":
        data.quadrant = value.toLowerCase();
        break;
      case "Tags":
        data.tags = value;
        break;
      case "Description":
      case "Context":
      case "Resources":
        // Combine these into content
        data.content = data.content ? `${data.content}\n\n## ${key}\n${value}` : `## ${key}\n${value}`;
        break;
    }
  }
  
  return data;
}

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
    
    // Get the issue content and extract form data
    const issueContent = issue.body || '';
    const formData = extractFormData(issueContent);
    
    // Parse tags into array format for the frontmatter
    let tagsFormatted = '[]';
    if (formData.tags) {
      const tagArray = formData.tags.split(',').map(tag => tag.trim());
      tagsFormatted = `[${tagArray.join(',')}]`;
    }
    
    // Use issue title as fallback if no title in form
    const title = formData.title || issue.title;
    
    // Create a filename based on title and issue number
    const safeTitle = title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    const filename = `${safeTitle}-${issue.number}.md`;
    const filepath = path.join(targetDirectory, filename);
    
    // Format the content with frontmatter metadata
    const formattedContent = `---
title: ${title}
ring: ${formData.ring || 'assess'}
quadrant: ${formData.quadrant || 'platforms-and-operations'}
tags: ${tagsFormatted}
champion: ${issue.user.login}
---

> From issue [#${issue.number}](${issue.html_url}) by [@${issue.user.login}](${issue.user.html_url})

${formData.content || issueContent}
`;
    
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


