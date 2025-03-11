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
    if (!formData.title) {
      setFailed("Missing required field: Technology Name");
      return;
    }
    
    if (!formData.ring) {
      setFailed("Missing required field: Ring");
      return;
    }
    
    if (!formData.quadrant) {
      setFailed("Missing required field: Quadrant");
      return;
    }
    
    if (!formData.department) {
      setFailed("Missing required field: Department");
      return;
    }
    
    // Parse tags into array format for the frontmatter
    let tagsFormatted = '[]';
    if (formData.tags) {
      const tagArray = formData.tags.split(',').map(tag => tag.trim());
      tagsFormatted = `[${tagArray.map(tag => `"${tag}"`).join(', ')}]`;
    }
    
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
    
    const filename = `${safeTitle}.md`;
    const filepath = path.join(targetDirectory, filename);
    
    // Format the new department entry
    const departmentEntry = `### ${formData.department} Assessment

\`\`\`yaml
ring: ${formData.ring || 'assess'}
champion: [@${issue.user.login}](${issue.user.html_url})
department: ${formData.department}
tags: ${tagsFormatted}
date: ${dateStr}
\`\`\`

> From issue [#${issue.number}](${issue.html_url})

${formData.content || issueContent}

---

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
      
      // File exists, get its content and add the new department entry
      const currentContent = Buffer.from((fileData as any).content, 'base64').toString('utf-8');
      
      // Check if the file has frontmatter
      let newContent: string;
      if (currentContent.startsWith('---')) {
        // File has frontmatter - preserve it and add the new department entry
        const frontmatterEnd = currentContent.indexOf('---', 3) + 3;
        const frontmatter = currentContent.substring(0, frontmatterEnd);
        const existingContent = currentContent.substring(frontmatterEnd);
        
        // Check if this department already has an entry
        const departmentEntryPattern = new RegExp(`---\\s*ring:.+?department:\\s*${formData.department}\\s*tags:`, 's');
        const departmentMatch = existingContent.match(departmentEntryPattern);
        
        if (departmentMatch) {
          // Department entry exists, find its boundaries and replace it
          const departmentStartIndex = existingContent.indexOf('---', existingContent.indexOf(departmentMatch[0]));
          let departmentEndIndex = existingContent.indexOf('---', departmentStartIndex + 3);
          
          // If another entry follows this one
          if (departmentEndIndex !== -1) {
            departmentEndIndex += 3; // Include the end marker
            newContent = frontmatter + 
              existingContent.substring(0, departmentStartIndex) +
              departmentEntry +
              existingContent.substring(departmentEndIndex);
          } else {
            // This is the last department entry
            newContent = frontmatter + 
              existingContent.substring(0, departmentStartIndex) +
              departmentEntry;
          }
        } else {
          // Department doesn't exist yet, add it
          newContent = frontmatter + existingContent + departmentEntry;
        }
      } else {
        // File doesn't have frontmatter - add new frontmatter + existing content + new department entry
        const frontmatter = `---
title: ${title}
quadrant: ${formData.quadrant}
---

`;
        newContent = frontmatter + currentContent + departmentEntry;
      }
      
      // Update the file
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: context.repo.owner,
        repo: context.repo.repo,
        path: filepath,
        message: `Update tech radar entry for ${formData.department} from issue #${issue.number}`,
        content: Buffer.from(newContent).toString('base64'),
        branch: defaultBranch,
        sha: (fileData as any).sha
      });
      
      console.log(`Successfully added department entry to tech radar entry at ${filepath}`);
      
    } catch (e) {
      // File doesn't exist, create it
      const formattedContent = `---
title: ${title}
quadrant: ${formData.quadrant}
---

${departmentEntry}`;
      
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





