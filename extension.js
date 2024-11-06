const vscode = require("vscode");
const cp = require("child_process");
const util = require("util");
const path = require("path");
const os = require("os");

const exec = util.promisify(cp.exec);
const isMacOS = os.platform() === "darwin";

let stageFilePicker;
let repoEventListener;
let updateTimer;
let fileWasOpened;

const extPrefix = "quickStage";
const whenContext = "QuickStageVisible";
const commands = {
  quickStage: `${extPrefix}.quickStage`,
  openDiff: `${extPrefix}.openDiff`,
  discardChanges: `${extPrefix}.discardChanges`,
  openFile: `${extPrefix}.openFile`,
  stageAll: `${extPrefix}.stageAll`,
  unstageAll: `${extPrefix}.unstageAll`,
  scrollEditorUp: `${extPrefix}.scrollUp`,
  scrollEditorDown: `${extPrefix}.scrollDown`,
};

const STATUS_SYMBOLS = [
  // staged
  'M',  // 0
  'A',  // 1
  'D',  // 2
  'R',  // 3
  'C',  // 4

  // unstaged
  'M',  // 5
  'D',  // 6
  'U',  // 7
  'I',  // 8
];

function useGitApi (){
  return vscode.extensions
  .getExtension("vscode.git")
  .exports.getAPI(1);
}

let scrollTimer;
let scrollCounter = 1;

function getScrollValue(){
  if (scrollTimer){
    clearTimeout(scrollTimer);
  }
  scrollTimer = setTimeout(() => {
    scrollCounter = 0;
  }, 350);
  return Math.min(Math.floor(1 + Math.log2((++scrollCounter + 15)/15)),5)
}

  //   Activate
  // ------------

async function activate(context) {
  context.subscriptions.push(

    // UI
    stageFilePicker,

    // |-----------------------------|
    // |      QuickStagePicker       |
    // |-----------------------------|

    vscode.commands.registerCommand(commands.quickStage, async () => {

      vscode.commands.executeCommand("setContext", whenContext, true); // set When context

      function exit(){
        if (stageFilePicker){stageFilePicker.dispose()};
        if (repoEventListener){repoEventListener.dispose()};
        vscode.commands.executeCommand("setContext", whenContext, false); // remove when context
      }

      // get gitAPI
      const gitAPI = useGitApi()
      if (!gitAPI) {
        vscode.window.showInformationMessage('SCM extension not found')
        return exit();
      }

      //   Repository
      // --------------

      const repositories = useGitApi().repositories;
      if (!repositories) {
        vscode.window.showInformationMessage('No Git repositories found')
        return exit();
      }

      let repository;
      const multipleRepositories = repositories.length > 1;
      if (multipleRepositories){
        const items = repositories.map(repo => ({
          label: path.basename(repo.rootUri.fsPath),
          description: repo.state.HEAD?.name || '',
          repository: repo
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a repository',
        });
        if (!selected) return exit(); // exit on 'esc'
        repository = selected.repository;
      } else { // only one repository
        repository = repositories.pop();
      }

      const {stagedChanges, unstagedChanges}= getChanges()
      if (unstagedChanges.length === 0 && stagedChanges.length === 0) {
        vscode.window.showInformationMessage("No Changes");
        return exit(); // no changes. exit.
      }

      repoEventListener = repository.repository.onDidRunOperation(()=>{
        if (stageFilePicker){
          if (stageFilePicker.ignoreFocusOut){stageFilePicker.ignoreFocusOut=false}
          const { stagedChanges, unstagedChanges} = getChanges()
          if (
            stagedChanges.length !== stageFilePicker.stagedChanges.length ||
            unstagedChanges.length !== stageFilePicker.unstagedChanges.length
          ) {
            if (updateTimer){
              clearTimeout(updateTimer)
            }
            updateTimer = setTimeout(() => {
              const index = stageFilePicker.selectionIndex
              stageFilePicker.updateItems(index ? index : 0);
              stageFilePicker.selectionIndex = null
            }, 50);
          }
        }
      })

      //   Create Picker
      // -----------------

      stageFilePicker = vscode.window.createQuickPick();
      stageFilePicker.keepScrollPosition = true;
      stageFilePicker.placeholder = "Select a file to Stage or Unstage ...";
      stageFilePicker.repository = repository
      stageFilePicker.multipleRepositories = multipleRepositories
      stageFilePicker.stagedChanges = stagedChanges
      stageFilePicker.unstagedChanges = unstagedChanges
      stageFilePicker.onDidTriggerItemButton(({button, item}) => button.trigger(item))


      //   Update UI
      // -------------

      stageFilePicker.updateItems = (index=0) => {
        // reset typed input
        stageFilePicker.value = "";

        const { stagedChanges, unstagedChanges } = getChanges()
        // changes might be discarded...
        if (unstagedChanges.length === 0 && stagedChanges.length === 0) {
          return exit(); // no changes. exit.
        }
        // update changes cache
        stageFilePicker.stagedChanges = stagedChanges
        stageFilePicker.unstagedChanges = unstagedChanges

        // create quickPick items
        const stagedItems = stagedChanges.map(createQuickPickItem);
        const unstagedItems = unstagedChanges.map(createQuickPickItem);

        const stageAllItem = {
          description: `      Stage All Changes (${
            isMacOS ? "⌘⇧S" : "Shift+Ctrl+S"
          })`,
          command: commands.stageAll,
        };
        const unstageAllItem = {
          description: `      Unstage All Changes (${
            isMacOS ? "⌘⇧U" : "Shift+Ctrl+U"
          })`,
          command: commands.unstageAll,
        };

        const unstagedChangesGroup = [];
        if (stagedChanges.length > 0) {
          unstagedChangesGroup.push(unstageAllItem);
        }
        unstagedChangesGroup.push({
          // separator
          label: `Changes (${unstagedChanges.length})`,
          kind: vscode.QuickPickItemKind.Separator,
        });
        unstagedChangesGroup.push(...unstagedItems);

        const stagedChangesGroup = [];
        if (unstagedChanges.length > 0) {
          stagedChangesGroup.push(stageAllItem);
        }
        stagedChangesGroup.push({
          // separator
          label: `Staged Changes (${stagedChanges.length})`,
          kind: vscode.QuickPickItemKind.Separator,
        });
        stagedChangesGroup.push(...stagedItems);

        stageFilePicker.items = [
          ...stagedChangesGroup,
          ...unstagedChangesGroup,
        ];

        //   set active item
        // -------------------
        while (
          stageFilePicker.items[index].command === commands.stageAll ||
          stageFilePicker.items[index].command === commands.unstageAll ||
          stageFilePicker.items[index].kind === vscode.QuickPickItemKind.Separator
        ) { index++ };
        stageFilePicker.activeItems = [stageFilePicker.items[index]];
      };

      stageFilePicker.updateItems();
      stageFilePicker.show();



      // |-----------------------------|
      // |        Functionality        |
      // |-----------------------------|

      function getChanges() {
        return {
          unstagedChanges: repository.state.workingTreeChanges,
          stagedChanges: repository.state.indexChanges,
        };
      }

      function createQuickPickItem(resource) {
        const filepath = resource.uri.fsPath;
        let directory = path.relative(repository.rootUri.fsPath, path.dirname(resource.uri.fsPath));
        if (directory !== "") directory = `${directory}${path.sep}`;
        const file = path.basename(filepath);
        const isStaged =  resource.status < 5;
        const stageSymbol = isStaged ? "diff-remove" : "diff-insert";
        const statusSymbol = STATUS_SYMBOLS[resource.status]
        const label = `$(${stageSymbol}) ${file}`;
        const description = `     ${statusSymbol ? statusSymbol : " "}     ${directory}`;

        let buttons = []
        // add discard changes only for unstaged files
        if (!isStaged){
          // discard Changes
          buttons.push({
            iconPath: new vscode.ThemeIcon("discard"),
            tooltip: "Discard Changes (Delete)",
            trigger: () => {
              vscode.commands.executeCommand(commands.discardChanges)
            }
          })
        }
        buttons = [
          ...buttons,
          // go to file
          {
            iconPath: new vscode.ThemeIcon("go-to-file"),
            tooltip: `Open File (${isMacOS ? "⌘O" : "Ctrl+O"})`,
            trigger: (selection) => {
              stageFilePicker.openFile(selection)
            }
          },
          // toggle stage
          {
            iconPath: new vscode.ThemeIcon(stageSymbol),
            tooltip: `${isStaged ? "Unstage" : "Stage"} File (Space)`,
            trigger: (selection) => {
              stageFilePicker.toggleStage(selection)
            }
          },
        ]
        return {
          label,
          description,
          resource,
          buttons,
        };
      }

      //   Stage File
      // --------------

      stageFilePicker.toggleStage = async (selection) => {
        const isStaged = selection.resource.status < 5
        if (isStaged){
          vscode.commands.executeCommand("git.unstage",selection.resource.resource)
        }else{
          vscode.commands.executeCommand("git.stage",selection.resource.resource)
        }

        // store the selectionIndex for use in repoEventListener()
        let selectionIndex = stageFilePicker.items.findIndex(
          (item) => item.resource && item.resource.uri.fsPath === selection.resource.uri.fsPath
        );
        // if the "unstageAll item" is added to the list
        // the desired target item is pushed down by one index
        if (stageFilePicker.stagedChanges.length === 0) {
          selectionIndex++;
        }
        stageFilePicker.selectionIndex = selectionIndex
      }

      fileWasOpened = false;

      //   Discard File
      // ----------------

      stageFilePicker.discardFile = (selection) => {
        vscode.commands.executeCommand("git.clean", selection.resource.resource)
      }

      //   Open File
      // -------------

      stageFilePicker.openFile = (selection) => {
        fileWasOpened = true
        vscode.commands.executeCommand("vscode.open", selection.resource.uri, { preview: false});
      }

      //   Diff File
      // -------------

      stageFilePicker.diffFile = (selection, options={}) => {
        vscode.commands.executeCommand(
          "vscode.diff",
          selection.resource.resource.leftUri,
          selection.resource.resource.rightUri,
          '',
          options
        );
      }

      // |------------------------------|
      // |        Input Handling        |
      // |------------------------------|

      //   on Arrow Keys
      // -----------------

      stageFilePicker.onDidChangeActive(([selection]) => {
        // preview the diff for the selected file
        if (vscode.workspace.getConfiguration(extPrefix).get('previewDiff', true) && selection.resource){
          stageFilePicker.diffFile(selection,{
              preview: true,
              preserveFocus: true
          });
        }
      });

      //   on Enter
      // ------------

      // these are both called on 'enter' when .canSelectMany is false
      // except .onDidAccept() is not passed .activeItems as params

      // stageFilePicker.onDidAccept();
      stageFilePicker.onDidChangeSelection(([selection]) => {
        if (selection) {
          switch (selection.command) {
            case commands.stageAll: // selection was stageAll
              vscode.commands.executeCommand(commands.stageAll);
              break;
            case commands.unstageAll: // selection was unstageAll
              vscode.commands.executeCommand(commands.unstageAll);
              break;
            default: // selection was a file
              stageFilePicker.toggleStage(selection)
            break;
          }
        }
      });

      //   on Esc
      // ----------

      stageFilePicker.onDidHide(() => {
        exit();

        if (vscode.workspace.getConfiguration(extPrefix).get('closePreviewOnExit', true)){
          const tabs = vscode.window.tabGroups.activeTabGroup.tabs
          tabs.forEach((tab) => {
            if (tab.isPreview){
              vscode.window.tabGroups.close(tab);
            }
          })
        }

        if (!fileWasOpened && vscode.workspace.getConfiguration(extPrefix).get('focusScmSidebarOnExit', true)){
          vscode.commands.executeCommand("workbench.scm.focus");
        }
      })

    }),

    //   on Space
    // ------------

    vscode.commands.registerCommand(commands.openDiff, () => {
      if (stageFilePicker) {
        const [selection] = stageFilePicker.activeItems
        if (selection){
          switch (selection.command) {
            case commands.stageAll:
              return; // do nothing
            case commands.unstageAll:
              return; // do nothing
            default:
              fileWasOpened = true
              stageFilePicker.diffFile(selection,{preserveFocus: true, preview: false});
            break;
          }
        }
      }
    }),

    //   Scroll Commands
    // -------------------

    // package.json:
    //  ctrl+left => scroll left
    //  ctrl+right => scroll right
    // ctrl+up => scroll up
    vscode.commands.registerCommand(commands.scrollEditorUp, () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get('previewDiff', true)) {
        vscode.commands.executeCommand("editorScroll",{ to: "up", by: "line", value: getScrollValue()})
      }
    }),
    // ctrl+down => scroll down
    vscode.commands.registerCommand(commands.scrollEditorDown, () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get('previewDiff', true)) {
        vscode.commands.executeCommand("editorScroll",{ to: "down", by: "line", value: getScrollValue()})
      }
    }),

    //   on Delete
    // -------------

    vscode.commands.registerCommand(commands.discardChanges, () => {
      if (stageFilePicker){
        stageFilePicker.ignoreFocusOut = true;
        const [selection] = stageFilePicker.activeItems;
        if (selection){
          switch (selection.command) {
            case commands.stageAll:
              return; // do nothing
            case commands.unstageAll:
              return; // do nothing
            default:
              stageFilePicker.discardFile(selection)
            break;
          }
        }
      }
    }),

    vscode.commands.registerCommand(commands.openFile, () => {
      if (stageFilePicker){
        stageFilePicker.ignoreFocusOut = false;
        const [selection] = stageFilePicker.activeItems;
        if (selection){
          switch (selection.command) {
            case commands.stageAll:
              return; // do nothing
            case commands.unstageAll:
              return; // do nothing
            default:
              stageFilePicker.openFile(selection)
            break;
          }
        }
      }
    }),

    vscode.commands.registerCommand(commands.stageAll, () => {
      if (stageFilePicker) {
        if (stageFilePicker.multipleRepositories){
          vscode.commands.executeCommand("git.stage", ...stageFilePicker.unstagedChanges.map(item => item.resource));
        } else {
          vscode.commands.executeCommand("git.stageAll");
        }
      }
    }),

    vscode.commands.registerCommand(commands.unstageAll, () => {
      if (stageFilePicker) {
        if (stageFilePicker.multipleRepositories){
          vscode.commands.executeCommand("git.unstage",...stageFilePicker.stagedChanges.map(item => item.resource));
        } else {
          vscode.commands.executeCommand("git.unstageAll");
        }
      }
    }),
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
