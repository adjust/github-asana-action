const core = require('@actions/core');
const github = require('@actions/github');
const asana = require('asana');

async function moveSection(asanaClient, taskId, targets) {
  const task = await asanaClient.tasks.findById(taskId);

  targets.forEach(async target => {
    const targetProject = task.projects.find(project => project.name === target.project);
    if (!targetProject) {
      core.info(`This task does not exist in "${target.project}" project`);
      return;
    }
    let targetSection = await asanaClient.sections.findByProject(targetProject.gid)
      .then(sections => sections.find(section => section.name === target.section));
    if (targetSection) {
      await asanaClient.sections.addTask(targetSection.gid, { task: taskId });
      core.info(`Moved to: ${target.project}/${target.section}`);
    } else {
      core.error(`Asana section ${target.section} not found.`);
    }
  });
}

async function findComment(asanaClient, taskId, commentId) {
  let stories;
  try {
    const storiesCollection = await asanaClient.tasks.stories(taskId);
    stories = await storiesCollection.fetch(200);
  } catch (error) {
    throw error;
  }

  return stories.find(story => story.text.indexOf(commentId) !== -1);
}

async function addComment(asanaClient, taskId, text, isPinned) {
  try {
    const comment = await asanaClient.tasks.addComment(taskId, {
      text: text,
      is_pinned: isPinned,
    });
    return comment;
  } catch (error) {
    console.error('rejecting promise', error);
  }
}

async function buildAsanaClient(asanaPAT) {
  return asana.Client.create({
    defaultHeaders: { 'asana-enable': 'new-sections,string_ids' },
    logAsanaChangeWarnings: false
  }).useAccessToken(asanaPAT).authorize();
}

async function action() {
  const ACTION = core.getInput('action', {required: true})
  const TRIGGER_PHRASE = core.getInput('trigger-phrase') || ''
  const REGEX_STRING = `${TRIGGER_PHRASE}(?:\s*)https:\\/\\/app.asana.com\\/(\\d+)\\/(?<project>\\d+)\\/(?<task>\\d+)`
  const REGEX = new RegExp(REGEX_STRING,'g')
  ;

  const asanaClient = await buildAsanaClient(process.env.ASANA_TOKEN);
  if(asanaClient === null){
    throw new Error('asanaClient authorization failed');
  }

  const githubClient = new github.GitHub(process.env.GITHUB_TOKEN, {});

  let PULL_REQUEST = github.context.payload.pull_request
  if(!PULL_REQUEST) {
    const pullRequests = await githubClient.repos.listPullRequestsAssociatedWithCommit({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      commit_sha: core.getInput('sha') || github.context.sha,
    });

    PULL_REQUEST = pullRequests.data.length > 0 && pullRequests.data[0];
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
      const linkRequired = core.getInput('link-required', {required: true}) === 'true';
      const statusState = (!linkRequired || foundAsanaTasks.length > 0) ? 'success' : 'error';
      core.info(`setting ${statusState} for ${github.context.payload.pull_request.head.sha}`);
      githubClient.repos.createStatus({
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
        let comment = await findComment(asanaClient, taskId, htmlText);
        if(comment){
          console.info('found existing comment', comment.gid);
          continue;
        }
        comment = await addComment(asanaClient, taskId, htmlText, isPinned);
        comments.push(comment);
      };
      return comments;
    }
    case 'remove-comment': {
      const commentId = core.getInput('comment-id', {required: true});
      const removedCommentIds = [];
      for(const taskId of foundAsanaTasks) {
        const comment = await findComment(asanaClient, taskId, commentId);
        if(comment){
          console.info("removing comment", comment.gid);
          try {
            await asanaClient.stories.delete(comment.gid);
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
          await asanaClient.tasks.update(taskId, {
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
        await moveSection(asanaClient, taskId, targets);
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
  buildAsanaClient: buildAsanaClient
};
