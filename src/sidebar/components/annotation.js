/* eslint consistent-this: ["error", "vm"] */

'use strict';

var annotationMetadata = require('../annotation-metadata');
var events = require('../events');
var persona = require('../filter/persona');

var isNew = annotationMetadata.isNew;
var isReply = annotationMetadata.isReply;
var isPageNote = annotationMetadata.isPageNote;

/**
 * Return a copy of `annotation` with changes made in the editor applied.
 */
function updateModel(annotation, changes, permissions) {
  var userid = annotation.user;

  return Object.assign({}, annotation, {
    // Apply changes from the draft
    tags: changes.tags,
    text: changes.text,
    permissions: changes.isPrivate ?
      permissions.private(userid) : permissions.shared(userid, annotation.group),
  });
}

// @ngInject
function AnnotationController(
  $document, $q, $rootScope, $scope, $timeout, $window, analytics, annotationUI,
  annotationMapper, drafts, flash, features, groups, permissions, serviceUrl,
  session, settings, store, streamer) {

  var vm = this;
  var newlyCreatedByHighlightButton;

  /** Save an annotation to the server. */
  function save(annot) {
    var saved;
    var updating = !!annot.id;

    if (updating) {
      saved = store.annotation.update({id: annot.id}, annot);
    } else {
      saved = store.annotation.create({}, annot);
    }

    return saved.then(function (savedAnnot) {

      var event;

      // Copy across internal properties which are not part of the annotation
      // model saved on the server
      savedAnnot.$tag = annot.$tag;
      Object.keys(annot).forEach(function (k) {
        if (k[0] === '$') {
          savedAnnot[k] = annot[k];
        }
      });


      if(vm.isReply()){
        event = updating ? analytics.events.REPLY_UPDATED : analytics.events.REPLY_CREATED;
      }else if(vm.isHighlight()){
        event = updating ? analytics.events.HIGHLIGHT_UPDATED : analytics.events.HIGHLIGHT_CREATED;
      }else if(isPageNote(vm.annotation)) {
        event = updating ? analytics.events.PAGE_NOTE_UPDATED : analytics.events.PAGE_NOTE_CREATED;
      }else {
        event = updating ? analytics.events.ANNOTATION_UPDATED : analytics.events.ANNOTATION_CREATED;
      }

      analytics.track(event);

      return savedAnnot;
    });
  }

  /**
    * Initialize this AnnotationController instance.
    *
    * Initialize the `vm` object and any other variables that it needs,
    * register event listeners, etc.
    *
    * All initialization code intended to run when a new AnnotationController
    * instance is instantiated should go into this function, except defining
    * methods on `vm`. This function is called on AnnotationController
    * instantiation after all of the methods have been defined on `vm`, so it
    * can call the methods.
    */
  function init() {
    // The remaining properties on vm are read-only properties for the
    // templates.

    /** Determines whether controls to expand/collapse the annotation body
     * are displayed adjacent to the tags field.
     */
    vm.canCollapseBody = false;

    /** Determines whether the annotation body should be collapsed. */
    vm.collapseBody = true;

    /** True if the annotation is currently being saved. */
    vm.isSaving = false;

    /** True if the 'Share' dialog for this annotation is currently open. */
    vm.showShareDialog = false;

    /**
      * `true` if this AnnotationController instance was created as a result of
      * the highlight button being clicked.
      *
      * `false` if the annotation button was clicked, or if this is a highlight
      * or annotation that was fetched from the server (as opposed to created
      * new client-side).
      */
    newlyCreatedByHighlightButton = vm.annotation.$highlight || false;

    // New annotations (just created locally by the client, rather then
    // received from the server) have some fields missing. Add them.
    vm.annotation.user = vm.annotation.user || session.state.userid;
    vm.annotation.group = vm.annotation.group || groups.focused().id;
    if (!vm.annotation.permissions) {
      vm.annotation.permissions = permissions.default(vm.annotation.user,
                                                      vm.annotation.group);
    }
    vm.annotation.text = vm.annotation.text || '';
    if (!Array.isArray(vm.annotation.tags)) {
      vm.annotation.tags = [];
    }

    // Automatically save new highlights to the server when they're created.
    // Note that this line also gets called when the user logs in (since
    // AnnotationController instances are re-created on login) so serves to
    // automatically save highlights that were created while logged out when you
    // log in.
    saveNewHighlight();

    // If this annotation is not a highlight and if it's new (has just been
    // created by the annotate button) or it has edits not yet saved to the
    // server - then open the editor on AnnotationController instantiation.
    if (!newlyCreatedByHighlightButton) {
      if (isNew(vm.annotation) || drafts.get(vm.annotation)) {
        vm.edit();
      }
    }
  }

  /** Save this annotation if it's a new highlight.
   *
   * The highlight will be saved to the server if the user is logged in,
   * saved to drafts if they aren't.
   *
   * If the annotation is not new (it has already been saved to the server) or
   * is not a highlight then nothing will happen.
   *
   */
  function saveNewHighlight() {
    if (!isNew(vm.annotation)) {
      // Already saved.
      return;
    }

    if (!vm.isHighlight()) {
      // Not a highlight,
      return;
    }

    if (vm.annotation.user) {
      // User is logged in, save to server.
      // Highlights are always private.
      vm.annotation.permissions = permissions.private(vm.annotation.user);
      save(vm.annotation).then(function(model) {
        model.$tag = vm.annotation.$tag;
        $rootScope.$broadcast(events.ANNOTATION_CREATED, model);
      });
    } else {
      // User isn't logged in, save to drafts.
      drafts.update(vm.annotation, vm.state());
    }
  }

  vm.authorize = function(action) {
    return permissions.permits(
      vm.annotation.permissions,
      action,
      session.state.userid
    );
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#flag
    * @description Flag the annotation.
    */
  vm.flag = function() {
    var onRejected = function(err) {
      flash.error(err.message, 'Flagging annotation failed');
    };
    annotationMapper.flagAnnotation(vm.annotation).then(function(){
      analytics.track(analytics.events.ANNOTATION_FLAGGED);
      annotationUI.updateFlagStatus(vm.annotation.id, true);
    }, onRejected);
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#delete
    * @description Deletes the annotation.
    */
  vm.delete = function() {
    return $timeout(function() {  // Don't use confirm inside the digest cycle.
      var msg = 'Are you sure you want to delete this annotation?';
      if ($window.confirm(msg)) {
        var onRejected = function(err) {
          flash.error(err.message, 'Deleting annotation failed');
        };
        $scope.$apply(function() {
          annotationMapper.deleteAnnotation(vm.annotation).then(function(){
            var event;

            if(vm.isReply()){
              event = analytics.events.REPLY_DELETED;
            }else if(vm.isHighlight()){
              event = analytics.events.HIGHLIGHT_DELETED;
            }else if(isPageNote(vm.annotation)){
              event = analytics.events.PAGE_NOTE_DELETED;
            }else {
              event = analytics.events.ANNOTATION_DELETED;
            }

            analytics.track(event);

          }, onRejected);
        });
      }
    }, true);
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#edit
    * @description Switches the view to an editor.
    */
  vm.edit = function() {
    if (!drafts.get(vm.annotation)) {
      drafts.update(vm.annotation, vm.state());
    }
  };

  /**
   * @ngdoc method
   * @name annotation.AnnotationController#editing.
   * @returns {boolean} `true` if this annotation is currently being edited
   *   (i.e. the annotation editor form should be open), `false` otherwise.
   */
  vm.editing = function() {
    return drafts.get(vm.annotation) && !vm.isSaving;
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#group.
    * @returns {Object} The full group object associated with the annotation.
    */
  vm.group = function() {
    return groups.get(vm.annotation.group);
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotaitonController#hasContent
    * @returns {boolean} `true` if this annotation has content, `false`
    *   otherwise.
    */
  vm.hasContent = function() {
    return vm.state().text.length > 0 || vm.state().tags.length > 0;
  };

  /**
    * Return the annotation's quote if it has one or `null` otherwise.
    */
  vm.quote = function() {
    if (vm.annotation.target.length === 0) {
      return null;
    }
    var target = vm.annotation.target[0];
    if (!target.selector) {
      return null;
    }
    var quoteSel = target.selector.find(function (sel) {
      return sel.type === 'TextQuoteSelector';
    });
    return quoteSel ? quoteSel.exact : null;
  };

  vm.id = function() {
    return vm.annotation.id;
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#isHighlight.
    * @returns {boolean} true if the annotation is a highlight, false otherwise
    */
  vm.isHighlight = function() {
    if (newlyCreatedByHighlightButton) {
      return true;
    } else if (isNew(vm.annotation)) {
      return false;
    } else {
      // Once an annotation has been saved to the server there's no longer a
      // simple property that says whether it's a highlight or not.  For
      // example there's no vm.annotation.highlight: true.  Instead a highlight is
      // defined as an annotation that isn't a page note or a reply and that
      // has no text or tags.
      return (!isPageNote(vm.annotation) && !isReply(vm.annotation) && !vm.hasContent());
    }
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#isShared
    * @returns {boolean} True if the annotation is shared (either with the
    * current group or with everyone).
    */
  vm.isShared = function() {
    return !vm.state().isPrivate;
  };

  // Save on Meta + Enter or Ctrl + Enter.
  vm.onKeydown = function (event) {
    if (event.keyCode === 13 && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      vm.save();
    }
  };

  vm.toggleCollapseBody = function(event) {
    event.stopPropagation();
    vm.collapseBody = !vm.collapseBody;
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#reply
    * @description
    * Creates a new message in reply to this annotation.
    */
  vm.reply = function() {
    var references = (vm.annotation.references || []).concat(vm.annotation.id);
    var group = vm.annotation.group;
    var replyPermissions;
    var userid = session.state.userid;
    if (userid) {
      replyPermissions = vm.state().isPrivate ?
        permissions.private(userid) : permissions.shared(userid, group);
    }
    annotationMapper.createAnnotation({
      group: group,
      references: references,
      permissions: replyPermissions,
      target: [{source: vm.annotation.target[0].source}],
      uri: vm.annotation.uri,
    });
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#revert
    * @description Reverts an edit in progress and returns to the viewer.
    */
  vm.revert = function() {
    drafts.remove(vm.annotation);
    if (isNew(vm.annotation)) {
      $rootScope.$broadcast(events.ANNOTATION_DELETED, vm.annotation);
    }
  };

  vm.save = function() {
    if (!vm.annotation.user) {
      flash.info('Please log in to save your annotations.');
      return Promise.resolve();
    }
    if (!vm.hasContent() && vm.isShared()) {
      flash.info('Please add text or a tag before publishing.');
      return Promise.resolve();
    }

    var updatedModel = updateModel(vm.annotation, vm.state(), permissions);

    // Optimistically switch back to view mode and display the saving
    // indicator
    vm.isSaving = true;

    return save(updatedModel).then(function (model) {
      Object.assign(updatedModel, model);

      vm.isSaving = false;

      var event = isNew(vm.annotation) ?
        events.ANNOTATION_CREATED : events.ANNOTATION_UPDATED;
      drafts.remove(vm.annotation);

      $rootScope.$broadcast(event, updatedModel);
    }).catch(function (err) {
      vm.isSaving = false;
      vm.edit();
      flash.error(err.message, 'Saving annotation failed');
    });
  };

  /**
    * @ngdoc method
    * @name annotation.AnnotationController#setPrivacy
    *
    * Set the privacy settings on the annotation to a predefined
    * level. The supported levels are 'private' which makes the annotation
    * visible only to its creator and 'shared' which makes the annotation
    * visible to everyone in the group.
    *
    * The changes take effect when the annotation is saved
    */
  vm.setPrivacy = function(privacy) {
    // When the user changes the privacy level of an annotation they're
    // creating or editing, we cache that and use the same privacy level the
    // next time they create an annotation.
    // But _don't_ cache it when they change the privacy level of a reply.
    if (!isReply(vm.annotation)) {
      permissions.setDefault(privacy);
    }
    drafts.update(vm.annotation, {
      tags: vm.state().tags,
      text: vm.state().text,
      isPrivate: privacy === 'private',
    });
  };

  vm.tagSearchURL = function(tag) {
    return serviceUrl('search.tag', {tag: tag});
  };

  // Note: We fetch the feature flag outside the `isOrphan` method to avoid a
  // lookup on every $digest cycle
  var indicateOrphans = features.flagEnabled('orphans_tab');

  vm.isOrphan = function() {
    if (!indicateOrphans) {
      return false;
    }
    if (typeof vm.annotation.$orphan === 'undefined') {
      return vm.annotation.$anchorTimeout;
    }
    return vm.annotation.$orphan;
  };

  vm.user = function() {
    return vm.annotation.user;
  };

  vm.isThirdPartyUser = function () {
    return persona.isThirdPartyUser(vm.annotation.user, settings.authDomain);
  };

  vm.isDeleted = function () {
    return streamer.hasPendingDeletion(vm.annotation.id);
  };

  vm.isHiddenByModerator = function () {
    return vm.annotation.hidden;
  };

  vm.canFlag = function () {
    if (persona.isThirdPartyUser(vm.annotation.user, settings.authDomain)) {
      return true;
    }
    return features.flagEnabled('flag_action');
  };

  vm.isFlagged = function() {
    return vm.annotation.flagged;
  };

  vm.isReply = function () {
    return isReply(vm.annotation);
  };

  vm.incontextLink = function () {
    if (vm.annotation.links) {
      return vm.annotation.links.incontext ||
             vm.annotation.links.html ||
             '';
    }
    return '';
  };

  /**
   * Sets whether or not the controls for expanding/collapsing the body of
   * lengthy annotations should be shown.
   */
  vm.setBodyCollapsible = function (canCollapse) {
    if (canCollapse === vm.canCollapseBody) {
      return;
    }
    vm.canCollapseBody = canCollapse;

    // This event handler is called from outside the digest cycle, so
    // explicitly trigger a digest.
    $scope.$digest();
  };

  vm.setText = function (text) {
    drafts.update(vm.annotation, {
      isPrivate: vm.state().isPrivate,
      tags: vm.state().tags,
      text: text,
    });
  };

  vm.setTags = function (tags) {
    drafts.update(vm.annotation, {
      isPrivate: vm.state().isPrivate,
      tags: tags,
      text: vm.state().text,
    });
  };

  vm.state = function () {
    var draft = drafts.get(vm.annotation);
    if (draft) {
      return draft;
    }
    return {
      tags: vm.annotation.tags,
      text: vm.annotation.text,
      isPrivate: !permissions.isShared(vm.annotation.permissions,
                                       vm.annotation.user),
    };
  };

  /**
   * Return true if the CC 0 license notice should be shown beneath the
   * annotation body.
   */
  vm.shouldShowLicense = function () {
    if (!vm.editing() || !vm.isShared()) {
      return false;
    }
    return vm.group().public;
  };

  init();
}

module.exports = {
  controller: AnnotationController,
  controllerAs: 'vm',
  bindings: {
    annotation: '<',
    showDocumentInfo: '<',
    onReplyCountClick: '&',
    replyCount: '<',
    isCollapsed: '<',
  },
  template: require('../templates/annotation.html'),

  // Private helper exposed for use in unit tests.
  updateModel: updateModel,
};
