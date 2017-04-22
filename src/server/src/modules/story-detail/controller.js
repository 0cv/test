import { Connection, Metadata, Project, Story, Storymetadata } from '../../models'
import { getHeaderMetadata, getUserId, metadata, streamClose, streamData, streamError } from '../../utils'
import { createSSHKey, getLatestCommits, gitDiff, transformFilesToJS, retrieveMetadataFromGit } from '../../background-services'
import mongoose from 'mongoose'
const path = require('path')
const execAsync = Promise.promisify(require('child_process').exec)

export async function getStory(ctx) {
  console.log('ctx.params._id', ctx.params._id)
  const story = await Story.findOne({
    _id: ctx.params._id,
    $or: [{
      sharedWith: ctx.session.passport.user._id
    }, {
      user: ctx.session.passport.user._id
    }]
  }).lean()

  // We fetch all the connections and get the list metadata for all them as a story could be assigned
  // to multiple connections... (and each connection may have different header metadata, e.g. Territory)
  const listMetadataTmp = await getHeaderMetadata(null, await Connection.find({user: ctx.session.passport.user._id}))

  let describeMetadata = {}
  if(listMetadataTmp) {
    for(let connectionId of Object.keys(listMetadataTmp)) {
      let headerMetadata = listMetadataTmp[connectionId]

      for (let metadata of headerMetadata) {
        describeMetadata[metadata.directoryName] = metadata
      }
    }
  }

  ctx.body = {
    describeMetadata,
    story,
    subMetadatas: {
      CustomObject: metadata.customObjectMetadata,
      SharingRules: metadata.sharingRulesMetadata,
      Workflow: metadata.workflowMetadata
    }
  }
}

export async function getMetadatas(ctx, data) {
  const userId = await getUserId(ctx)
  console.log('cookie/storyId=>', userId, data.storyId)

  const storyMetadatas = [],
    metadataIds = []

  let metadataFullpaths = [],
    finalDifferences = []

  const story = await Story.findOne({
    _id: data.storyId,
    $or: [{
      sharedWith: userId
    }, {
      user: userId
    }]
  }).lean()

  if(!story || !story._id) {
    return
  }

  // We pull the metadata from the remote repo

  if(story.repository &&
      story.branch &&
      story.project &&
      story.privateKey &&
      story.gitServer) {

    const fakeConnection = {
      _id: story._id,
      user: userId,
      folder: story.repository,
      companyfolder: story.organization,
      branch: story.branch,
      privatekey: story.privateKey,
      gitserver: story.gitServer
    }

    await createSSHKey([fakeConnection])

    const latestRemoteCommit = await getLatestCommits([fakeConnection])
    console.log('latestRemoteCommit', latestRemoteCommit)
    console.log('story', story)
    if(latestRemoteCommit.get(fakeConnection._id.toString()) &&
        latestRemoteCommit.get(fakeConnection._id.toString()) !== story.latestCommit) {
      // Let's check whether the latest commit on the story is the same than the latest commit in Git...
      // (could not be the same in case for example a commit has been done manually)

      // There is one or more commit on Git, which are not included in the DB... We have to pull them first.

      //we are going to pull the branch from the repository to get the latest version.

      const project = await Project.findOne({
        _id: story.project
      }).lean()

      const connection = await Connection.findOne({
        _id: project.connection
      }).lean()

      await retrieveMetadataFromGit([fakeConnection], userId, true, true)

      const pfad = path.join(userId, fakeConnection._id.toString())

      try {
        await execAsync(`cd ${pfad} && git checkout ${story.branch}`)
      } catch(e) {
        console.error('git checkout branch:', e)
        return
      }

      // Find the latest commit from the branch which has been subject to a merge (into the Master)
      let firstCommit
      try {
        firstCommit = await execAsync(`cd ${pfad} && git merge-base master ${story.branch}`)
        firstCommit = firstCommit.split('\n')[0]
      } catch(e) {
        console.error('git merge-base master branch:', e)
        return
      }

      // List the difference of files between the HEAD and the latest merge on master
      let differences = await gitDiff(fakeConnection, firstCommit, userId)
      // These differences must be extracted - particularly changes happening within complex metadata (e.g. a field in Account.object)

      // We store in a variable the changes from the HEAD
      const latestMetadata = [], originMetadata = []

      const folders = new Set()

      differences.forEach(difference => folders.add(difference.split('/')[0]) )

      let fileNames = {}
      for(let difference of differences) {
        let folder = difference.split('/')[0]
        if(!(folder in fileNames)) {
          fileNames[folder] = []
        }
        fileNames[folder].push(difference.substring(difference.indexOf('/') + 1))
      }

      //we describe the metadata of the different connections
      //storing all the top metadata per connection
      const metadataTemp = await getHeaderMetadata(null, [connection])
      const mapMetadata = new Map()
      if(!metadataTemp) {
        // Nothing to proceed
        return
      }
      for(let connectionId of Object.keys(metadataTemp)) {
        for (let metadata of metadataTemp[connectionId]) {
          mapMetadata.set(metadata.directoryName, metadata)
        }
      }
      // console.log('mapMetadata', mapMetadata)
      let upsertedMetadataPath = new Set()

      for(let folder of folders) {
        latestMetadata.push(...await transformFilesToJS(
          userId,
          folder,
          fileNames[folder],
          mapMetadata.get(folder).xmlName, //e.g. ApexClass,
          story._id.toString(),
          new Map(),
          upsertedMetadataPath,
          story.project,
          false
        ))
      }

      // And now we do the same for the changes of the commit of the latest merge
      //checkout of the beginning of the branch
      try {
        await execAsync(`cd ${pfad} && git checkout ${firstCommit}`)
      } catch(e) {
        console.error('git checkout branch:', e)
        return
      }
      upsertedMetadataPath = new Set()

      for(let folder of folders) {
        originMetadata.push(...await transformFilesToJS(
          userId,
          folder,
          fileNames[folder],
          mapMetadata.get(folder).xmlName, //e.g. ApexClass,
          story._id.toString(),
          new Map(),
          upsertedMetadataPath,
          story.project,
          false
        ))
      }

      // And now we compare both and check the real differences between latestMetadata and originMetadata
      for(let latest of latestMetadata) {
        latest = latest.insertOne.document
        let originIndex = originMetadata.findIndex(tmp => tmp.insertOne.document.fullPath === latest.fullPath)
        let origin

        if(originIndex > -1) {
          origin = originMetadata[originIndex]
          originMetadata.splice(originIndex, 1)
        }
        if( originIndex === -1 ||
            origin.insertOne.document.newValueBin !== latest.newValueBin ||
            origin.insertOne.document.newValue !== latest.newValue) {

          latest.isDeleted = false
          finalDifferences.push(latest)
        }
      }

      if(originMetadata.length) {
        for(let latest of originMetadata) {
          latest.isDeleted = true
          finalDifferences.push(latest)
        }
      }

      finalDifferences = finalDifferences.map(finalDifference => ({
        fullPath: finalDifference.fullPath,
        isDeleted: finalDifference.isDeleted,
        // metadata: mongoose.Types.ObjectId(???),
        newValue: finalDifference.newValue,
        newValueBin: finalDifference.newValueBin,
        project: mongoose.Types.ObjectId(story.project),
        story: mongoose.Types.ObjectId(story._id),
        updated_at: new Date()

      }))

      let toUpsert = []
      for(let finalDifference of finalDifferences) {
        toUpsert.push({
          insertOne: {
            document: finalDifference
          }
        })
      }

      const result = await Storymetadata.collection.bulkWrite(toUpsert, {
        ordered: false
      })

      console.log('finalDifferences', finalDifferences)

      //we still need to query the metadata from the Org
      metadataFullpaths = finalDifferences.map(finalDifference => finalDifference.fullPath)
      delayedQueries(true)
    } else {
      getStoryMetadata()
    }
  } else {
    getStoryMetadata()
  }

  function getStoryMetadata() {
    // Without a repository and branch, we fetch the story metadata saved in the MongoDB.
    const storyMetadataStream = Storymetadata.find({
      story: data.storyId
    }).lean().batchSize(10000).cursor()

    storyMetadataStream.on('data', streamData(ctx, 'storyMetadatas', storyMetadatas, 10000, metadataIds, 'metadata'))
    storyMetadataStream.on('error', streamError)
    storyMetadataStream.on('end', streamClose(ctx, 'storyMetadatas', storyMetadatas, delayedQueries))
  }

  function delayedQueries(queryFullpaths) {
    console.info('doing now delayedQueries...')
    //querying the storyMetadata
    let query
    if(queryFullpaths) {
      query = {
        fullPath: {
          '$in': metadataFullpaths
        },
        project: story.project
      }
    } else {
      query = {
        _id: {
          '$in': metadataIds
        }
      }
    }
    const metadataStream = Metadata.find(query).lean().batchSize(5000).cursor()
    let metadatas = []

    metadataStream.on('error', streamError)

    if(queryFullpaths) {
      // We don't stream anything to the client, so that we can keep the metadata for assigning the _id at the end
      metadataStream.on('data', streamData(ctx, null, metadatas, 0))
      metadataStream.on('end', function() {
        // We need to assign here the _id to the StoryMetadata, by using the fullPath as a key.
        // The _id is used by default on the FrontEnd.

        console.log('metadatas', metadatas)

        for(let finalDifference of finalDifferences) {
          let metadata = metadatas.find(tmp => tmp.fullPath === finalDifference.fullPath)
          console.log('metadata', metadata)
          if(metadata) {
            finalDifference.metadata = metadata._id
          }
        }
        console.log('finalDifferences2', finalDifferences)

         // we send the storyMetadata to the client
        streamClose(ctx, 'storyMetadatas', finalDifferences)()

        // we send the metadatas to the client
        streamClose(ctx, 'metadatas', metadatas)()
      })
    } else {
      metadataStream.on('data', streamData(ctx, 'metadatas', metadatas, 5000))
      metadataStream.on('end', streamClose(ctx, 'metadatas', metadatas))
    }
  }
}


export async function storyMetadataRemove(ctx, data) {
  const userId = await getUserId(ctx)

  console.log('storyMetadataRemove', data.ids)
  try {
    const idsToDelete = data.ids.map(id => mongoose.Types.ObjectId(id))

    const stories = await Story.find({
      $or: [{
        sharedWith: userId
      }, {
        user: userId
      }]
    }).lean()

    const storyIds = stories.map(story => story._id)

    const result = await Storymetadata.collection.bulkWrite([{
      deleteMany: {
        filter: {
          _id: {
            $in: idsToDelete
          },
          story: {
            $in: storyIds
          }
        }
      }
    }], {
      ordered: false
    })

    console.log('Storymetadata deleted...', result);

    ctx.socket.emit('addRemoveMetadataSave', result)
  } catch(e) {
    console.error('error in storyRemove ...', e)
  }
}
