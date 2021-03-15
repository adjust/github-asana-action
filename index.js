const core = require('@actions/core');
const github = require('@actions/github');
const asana = require('asana');

async function moveSection(client, taskId, targets) {
  const task = await client.tasks.findById(taskId);

  targets.forEach(async target => {
    const targetProject = task.projects.find(project => project.name === target.project);
    if (!targetProject) {
      core.info(`This task does not exist in "${target.project}" project`);
      return;
    }
    let targetSection = await client.sections.findByProject(targetProject.gid)
      .then(sections => sections.find(section => section.name === target.section));
    if (targetSection) {
      await client.sections.addTask(targetSection.gid, { task: taskId });
      core.info(`Moved to: ${target.project}/${target.section}`);
    } else {
      core.error(`Asana section ${target.section} not found.`);
    }
  });
}

async function findComment(client, taskId, commentId) {
  let stories;
  try {
    const storiesCollection = await client.tasks.stories(taskId);
    stories = await storiesCollection.fetch(200);
  } catch (error) {
    throw error;
  }

  return stories.find(story => story.text.indexOf(commentId) !== -1);
}

async function addComment(client, taskId, text, isPinned) {
  try {
    const comment = await client.tasks.addComment(taskId, {
      text: text,
      is_pinned: isPinned,
    });
    return comment;
  } catch (error) {
    console.error('rejecting promise', error);
  }
}

async function buildClient(asanaPAT) {
  return asana.Client.create({
    defaultHeaders: { 'asana-enable': 'new-sections,string_ids' },
    logAsanaChangeWarnings: false
  }).useAccessToken(asanaPAT).authorize();
}

async function action() {
  const
    ASANA_PAT = process.env.ASANA_TOKEN,
    ACTION = core.getInput('action', {required: true}),
    TRIGGER_PHRASE = core.getInput('trigger-phrase') || '',
    PULL_REQUEST = github.context.payload.pull_request,
    REGEX_STRING = `${TRIGGER_PHRASE}(?:\s*)https:\\/\\/app.asana.com\\/(\\d+)\\/(?<project>\\d+)\\/(?<task>\\d+)`,
    REGEX = new RegExp(REGEX_STRING,'g')
  ;

  const client = await buildClient(ASANA_PAT);
  if(client === null){
    throw new Error('client authorization failed');
  }

  console.info('looking in body', PULL_REQUEST.body, 'regex', REGEX_STRING);
  let foundAsanaTasks = [];
  while ((parseAsanaURL = REGEX.exec(PULL_REQUEST.body)) !== null) {
    const taskId = parseAsanaURL.groups.task;
    if (!taskId) {
      core.error(`Invalid Asana task URL after the trigger phrase ${TRIGGER_PHRASE}`);
      continue;
    }
    foundAsanaTasks.push(taskId);
  }
  console.info(`found ${foundAsanaTasks.length} taskIds:`, foundAsanaTasks.join(','));

  console.info('calling', ACTION);
  switch(ACTION){
    case 'assert-link': {
      const githubToken = core.getInput('github-token', {required: true});
      const linkRequired = core.getInput('link-required', {required: true}) === 'true';
      const octokit = new github.GitHub(githubToken);
      const statusState = (!linkRequired || foundAsanaTasks.length > 0) ? 'success' : 'error';
      core.info(`setting ${statusState} for ${github.context.payload.pull_request.head.sha}`);
      octokit.repos.createStatus({
        ...github.context.repo,
        'context': 'asana-link-presence',
        'state': statusState,
        'description': 'asana link not found',
        'sha': github.context.payload.pull_request.head.sha,
      });
      break;
    }
    case 'add-comment': {
      const htmlText = core.getInput('text', {required: true});
      const isPinned = core.getInput('is-pinned') === 'true';
      const comments = [];
      for(const taskId of foundAsanaTasks) {
        let comment = await findComment(client, taskId, htmlText);
        if(comment){
          console.info('found existing comment', comment.gid);
          continue;
        }
        comment = await addComment(client, taskId, htmlText, isPinned);
        comments.push(comment);
      };
      return comments;
    }
    case 'remove-comment': {
      const commentId = core.getInput('comment-id', {required: true});
      const removedCommentIds = [];
      for(const taskId of foundAsanaTasks) {
        const comment = await findComment(client, taskId, commentId);
        if(comment){
          console.info("removing comment", comment.gid);
          try {
            await client.stories.delete(comment.gid);
          } catch (error) {
            console.error('rejecting promise', error);
          }
          removedCommentIds.push(comment.gid);
        }
      }
      return removedCommentIds;
    }
    case 'complete-task': {
      const isComplete = core.getInput('is-complete') === 'true';
      const taskIds = [];
      for(const taskId of foundAsanaTasks) {
        console.info("marking task", taskId, isComplete ? 'complete' : 'incomplete');
        try {
          await client.tasks.update(taskId, {
            completed: isComplete
          });
        } catch (error) {
          console.error('rejecting promise', error);
        }
        taskIds.push(taskId);
      };
      return taskIds;
    }
    case 'move-section': {
      const targetJSON = core.getInput('targets', {required: true});
      const targets = JSON.parse(targetJSON);
      const movedTasks = [];
      for(const taskId of foundAsanaTasks) {
        await moveSection(client, taskId, targets);
        movedTasks.push(taskId);
      }
      return movedTasks;
    }
    default:
      core.setFailed("unexpected action ${ACTION}");
  }
}

module.exports = {
  action,
  default: action,
  buildClient: buildClient
};
