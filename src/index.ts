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
      case "Department":
        data.department = value;
        break;
      case "Champion":
        data.champion = value;
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
    const baseDirectory = getInput('target-directory') || 'radar';
    
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
    
    // Validate required fields
    if (!formData.title || formData.title.toLowerCase() === "no response") {
      setFailed("Missing required field: Technology Name");
      return;
    }
    
    if (!formData.ring || formData.ring.toLowerCase() === "no response") {
      setFailed("Missing required field: Ring");
      return;
    }
    
    if (!formData.quadrant || formData.quadrant.toLowerCase() === "no response") {
      setFailed("Missing required field: Quadrant");
      return;
    }
    
    if (!formData.domain || formData.department.toLowerCase() === "no response") {
      setFailed("Missing required field: Department");
      return;
    }
    
    // Parse tags into array format for the frontmatter
    let tagsFormatted = '';
    if (formData.tags && formData.tags.trim() !== '') {
      const tagArray = formData.tags.split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0); // Filter out empty tags
      
      if (tagArray.length > 0) {
        tagsFormatted = `[${tagArray.map(tag => `"${tag}"`).join(', ')}]`;
      }
    }

    // Extract domain as a separate field
    const domainFormatted = formData.department ? 
      `["${formData.department}"]` : 
      '[]';

    // Generate date-based directory structure (YYYY-MM-DD)
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0]; // Format: YYYY-MM-DD
    const targetDirectory = path.join(baseDirectory, dateStr);
    
    // Use issue title as fallback if no title in form
    const title = formData.title || issue.title;
    
    // Create a filename based ONLY on the technology name (not issue number)
    const safeTitle = title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    if (safeTitle.length === 0) {
      setFailed("Invalid technology name: cannot generate a valid filename");
      return;
    }
    
    const filename = `${safeTitle}.md`;
    const filepath = path.join(targetDirectory, filename);
    
    // Format the content with all metadata in frontmatter
    const formattedContent = `---
title: ${title}
quadrant: ${formData.quadrant}
ring: ${formData.ring || 'assess'}
tags: ${tagsFormatted || '[]'}
domain: ${domainFormatted}
champion: ${formData.champion || issue.user.login}
date: ${dateStr}
---

> From issue [#${issue.number}](${issue.html_url})

${formData.content || issueContent}
`;
    
    // Get the default branch
    const { data: repoData } = await octokit.rest.repos.get({
      owner: context.repo.owner,
      repo: context.repo.repo
    });
    
    const defaultBranch = repoData.default_branch;
    
    // First, check if the directory exists
    let dirExists = true;
    try {
      await octokit.rest.repos.getContent({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: targetDirectory,
        ref: defaultBranch
      });
    } catch (error) {
      // Directory doesn't exist
      dirExists = false;
    }
    
    // Create the directory if it doesn't exist
    if (!dirExists) {
      console.log(`Creating directory: ${targetDirectory}`);
      
      // We need to create a file to create a directory in GitHub
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: path.join(targetDirectory, '.gitkeep'),
        message: `Create ${dateStr} directory for tech radar entries`,
        content: Buffer.from('').toString('base64'),
        branch: defaultBranch
      });
    }
    
    try {
      // Check if file already exists
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: filepath,
        ref: defaultBranch
      });
      
      // File exists - but we'll just replace it with the new content
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: filepath,
        message: `Update tech radar entry for ${formData.department} from issue #${issue.number}`,
        content: Buffer.from(formattedContent).toString('base64'),
        branch: defaultBranch,
        sha: (fileData as any).sha
      });
      
      console.log(`Successfully updated tech radar entry at ${filepath}`);
      
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
        
      console.log(`Successfully created new tech radar entry at ${filepath}`);
    }
    
  } catch (error) {
    console.error(error);
    setFailed((error as Error)?.message ?? 'Unknown error');
  }
}

run();





