/*global define, ace, URL*/
define("tree3", function () {
  var $ = require('elements');
  var modes = require('modes');
  var editor = require('editor');
  var domBuilder = require('dombuilder');
  var modelist = ace.require('ace/ext/modelist');
  var whitespace = ace.require('ace/ext/whitespace');
  var contextMenu = require('context-menu');
  var pathCmp = require('encoders').pathCmp;
  var prefs = require('prefs');
  var binary = require('binary');
  var dialog = require('dialog');
  require('zoom');

  var imagetypes = {
    gif:  "image/gif",
    jpg:  "image/jpeg",
    jpeg: "image/jpeg",
    png:  "image/png",
    svg:  "image/svg+xml",
  };

  var openPaths = prefs.get("openPaths", {});
  var selectedPath = "";
  var activePath = "";
  // Active documents by path
  var docPaths = {};
  // repos by path
  var repos = {};
  // roots by name
  var roots = {};


  $.tree.addEventListener("click", onClick, false);
  $.tree.addEventListener("contextmenu", onContextMenu, false);

  addRoot.refresh = refresh;
  return addRoot;

  function addRoot(repo, hash, name) {
    findRepos(repo, name);
    roots[name] = {repo:repo, hash:hash};
    refresh();
  }

  function refresh() {
    var keys = Object.keys(roots);
    var left = keys.length;
    if (!left) {
      $.tree.textContent = "";
      return;
    }
    var items = [];
    keys.forEach(function (name) {
      var root = roots[name];
      renderCommit(root.repo, root.hash, name, name, function (err, ui) {
        if (err) throw err;
        items.push(domBuilder(ui));
        if (--left) return;
        $.tree.textContent = "";
        $.tree.appendChild(domBuilder(items));
      });
    });

  }

  function findRepos(repo, path) {
    repos[path] = repo;
    var submodules = repo.submodules;
    if (!submodules) return;
    Object.keys(submodules).forEach(function (subPath) {
      findRepos(submodules[subPath], path + "/" + subPath);
    });
  }

  function renderCommit(repo, hash, name, path, callback) {
    if (!repo.head) repo.head = hash;
    repo.loadAs("commit", hash, function (err, commit) {
      if (!commit) return callback(err || new Error("Missing commit " + hash));
      renderTree(repo, commit.tree, name, path, function (err, ui) {
        if (err) return callback(err);
        ui[1][1]["data-commit-hash"] = hash;
        if (hash !== repo.head) ui[1][1]["class"] += " staged";
        ui[1].splice(3, 0, ["i.icon-fork.tight"]);
        callback(null, ui);
      });
    });
  }

  function renderNode(hash, mode, name, path) {
    var icon = modes.isFile(mode) ? "doc" :
      mode === modes.sym ? "link" :
      openPaths[path] ? "folder-open" : "folder";
    var classes = ["row"];
    if (selectedPath === path) classes.push("selected");
    if (activePath === path) classes.push("activated");

    var rowProps = {
      "data-hash": hash,
      "data-path": path,
      "data-mode": mode.toString(8),
      "class": classes.join(" ")
    };
    var spanProps = {};
    if (mode === modes.exec) spanProps["class"] = "executable";
    return ["li",
      ["div", rowProps,
        ["i.icon-" + icon],
        ["span", spanProps, name]
      ]
    ];
  }

  function renderTree(repo, hash, name, path, callback) {
    repo.loadAs("tree", hash, function (err, tree) {
      if (!tree) return callback(err || new Error("Missing tree " + hash));
      var open = openPaths[path];
      var ui = renderNode(hash, modes.tree, name, path);
      var names = Object.keys(tree);
      if (!open || !names.length) return callback(null, ui);
      var left = names.length;
      var children = new Array(left);
      Object.keys(tree).sort(pathCmp).forEach(function (name, i) {
        var childPath = path ? path + "/" + name : name;
        var entry = tree[name];
        if (modes.isBlob(entry.mode)) {
          return onChild(null, renderNode(entry.hash, entry.mode, name, childPath));
        }
        if (entry.mode === modes.tree) {
          return renderTree(repo, entry.hash, name, childPath, onChild);
        }
        if (entry.mode === modes.commit) {
          var submodule = repos[childPath];
          if (!submodule) throw new Error("Missing submodule " + childPath);
          return renderCommit(submodule, entry.hash, name, childPath, onChild);
        }
        function onChild(err, childUi) {
          if (err) throw err;
          children[i] = childUi;
          if (--left) return;
          ui.push(["ul", children]);
          callback(null, ui);

        }

      });
    });
  }


  function findJs(node) {
    while (node !== $.tree) {
      var hash = node.getAttribute("data-hash");
      if (hash) return node.dataset;
      node = node.parentElement;
    }
  }

  function onClick(evt) {
    var node = findJs(evt.target);
    if (!node) return;
    evt.preventDefault();
    evt.stopPropagation();
    var mode = parseInt(node.mode, 8);
    var path = node.path;

    // Trees toggle on click
    if (mode === modes.tree) {
      if (openPaths[path]) delete openPaths[path];
      else openPaths[path] = true;
      prefs.set("openPaths", openPaths);
      return refresh();
    }

    activate(node);

  }

  function activate(node) {
    var path = node.path;
    if (activePath === path) {
      activePath = null;
      refresh();
      return loadDoc();
    }
    activePath = node.path;
    refresh();
    var doc = docPaths[path];
    if (doc) return loadDoc(doc);
    var repo = findRepo(path);
    if (!repo) throw new Error("Missing repo for " + path);
    var name = getName(path);
    return repo.loadAs("blob", node.hash, function (err, buffer) {
      if (err) throw err;
      var imageMime = imagetypes[getExtension(name)];
      if (imageMime) {
        doc = docPaths[path] = {
          tiled: false,
          path: path,
          url: URL.createObjectURL(new Blob([buffer], {type: imageMime}))
        };
        return loadDoc(doc);
      }

      var mode = parseInt(node.mode, 8) === modes.sym ?
        "ace/mode/text" : modelist.getModeForPath(name).mode;

      var code;
      try {
        code = binary.toUnicode(buffer);
      }
      catch (err) {
        // Data is not unicode!
        return;
      }
      doc = docPaths[path] = ace.createEditSession(code, mode);
      doc.setTabSize(2);
      doc.path = path;
      doc.on("change", changeSaver(doc));
      whitespace.detectIndentation(doc);
      loadDoc(doc);
    });


  }

  function loadDoc(doc, soft) {
    editor.setDoc(doc);
    if (!soft) editor.focus();
  }

  function findRepo(path) {
    var keys = Object.keys(repos);
    var longest = "";
    for (var i = 0, l = keys.length; i < l; i++) {
      var key = keys[i];
      if (key.length < longest.length) continue;
      if (path.substr(0, key.length) !== key) continue;
      longest = key;
    }
    if (longest) return repos[longest];
  }

  function pathToEntry(path, callback) {
    var index = path.indexOf("/");
    var root = roots[path.substr(0, index)];
    root.repo.loadAs("commit", root.hash, function (err, commit) {
      if (err) return callback(err);
      root.repo.pathToEntry(commit.tree, path.substr(index + 1), callback);
    });
  }

  function getType(node) {
    var mode = parseInt(node.mode, 8);
    return node.commitHash ? "submodule" :
      mode === modes.tree ? "folder" :
      mode === modes.sym ? "symlink" : "file";
  }

  function getName(path) {
    return path.substr(path.lastIndexOf("/") + 1);
  }

  function getExtension(name) {
    return name.substr(name.lastIndexOf(".") + 1);
  }

  function getChain(path, callback) {
    var parts = path.split("/").filter(Boolean);
    var chain = [];
    var name = parts.shift();
    path = name;
    var root = roots[name];
    var repo = root.repo;
    return loadCommit(root.hash);

    function loadCommit(hash) {
      repo.loadAs("commit", hash, function (err, commit) {
        if (!commit) return callback(err || new Error("Invalid commit " + hash));
        chain.push({
          repo: repo,
          name: name,
          commit: commit
        });
        loadTree(commit.tree, name);
      });
    }

    function loadTree(hash) {
      repo.loadAs("tree", hash, function (err, tree) {
        if (!tree) return callback(err || new Error("Invalid tree " + hash));
        chain.push({
          repo: repo,
          name: name,
          tree: tree
        });
        if (!parts.length) return callback(null, chain);
        name = parts.shift();
        path += "/" + name;
        var entry = tree[name];
        if (!entry) return callback(new Error("Bad path " + path));
        if (entry.mode === modes.commit) {
          repo = repos[path];
          if (!repo) return callback(new Error("Missing repo " + path));
          return loadCommit(entry.hash);
        }
        if (entry.mode === modes.tree) {
          return loadTree(entry.hash);
        }
        chain.push({
          repo: repo,
          name: name,
          mode: entry.mode
        });
        callback(null, chain);
      });
    }
  }

  function saveChain(chain, name, hash, callback) {
    pop();
    function pop() {
      var entry = chain.pop();
      if (!entry) {
        roots[name].hash = hash;
        callback && callback();
        return refresh();
      }
      if (entry.commit) {
        var commit = entry.commit;
        commit.tree = hash;
        return entry.repo.saveAs("commit", commit, onSave);
      }
      var tree = entry.tree;
      tree[name].hash = hash;
      name = entry.name;
      return entry.repo.saveAs("tree", tree, onSave);
    }
    function onSave(err, result) {
      if (err) throw err;
      hash = result;
      pop();
    }

  }

  function saveTree(chain, callback) {
    var entry = chain.pop();
    entry.repo.saveAs("tree", entry.tree, function (err, hash) {
      if (callback) callback(err, hash);
      else if (err) throw err;
      saveChain(chain, entry.name, hash);
    });
  }

  function changeSaver(doc) {
    var timeout, chain, tree, value, name, dir;

    return function () {
      if (value === doc.getValue()) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(onTimeout, 500);
    };

    function onTimeout() {
      timeout = null;
      value = doc.getValue();
      if (doc.savedValue === value) return;
      doc.savedValue = value;
      var index = doc.path.lastIndexOf("/");
      name = doc.path.substr(index + 1);
      dir = doc.path.substr(0, index);
      getChain(dir, onChain);
    }

    function onChain(err, result) {
      if (err) throw err;
      chain = result;
      tree = chain[chain.length - 1];
      tree.repo.saveAs("blob", value, onHash);
    }
    function onHash(err, hash) {
      if (err) throw err;
      tree.tree[name].hash = hash;
      saveTree(chain);
      chain = tree = value = name = dir = null;
    }

  }


  function revertChanges(node) {
    getChain(node.path, function (err, chain) {
      if (err) throw err;
      chain.pop(); // Throw away the tree
      var entry = chain.pop();
      var hash = entry.repo.head;
      var name = entry.name;
      // TODO: restore any submodules that were renamed
      saveChain(chain, name, hash, function () {
        updateDocs(node.path);
        editor.focus();
      });
    });
  }

  function updateDocs(path) {
    var prefix = makePrefix(path);
    Object.keys(docPaths).forEach(function (path) {
      if (!prefix.test(path)) return;
      var doc = docPaths[path];
      pathToEntry(path, function (err, entry, repo) {
        if (err) throw err;
        if (!entry) {
          delete docPaths[path];
          if (activePath === path) editor.setDoc();
          return;
        }
        repo.loadAs("text", entry.hash, function (err, text) {
          if (err) throw err;
          // TODO: set mode in case extension changed
          doc.setMode(modelist.getModeForPath(path).mode);
          doc.savedValue = text;
          doc.setValue(text);
        });
      });
    });
  }

  function createNode(path, mode, type, value, label) {
    var chain;
    var tree;
    var name;
    var repo;
    var entry;
    getChain(path, function (err, result) {
      if (err) throw err;
      chain = result;
      var entry = chain[chain.length - 1];
      tree = entry.tree;
      name = entry.name;
      repo = entry.repo;
      doPrompt();
    });
    function doPrompt() {
      dialog.prompt("Enter name for new " + label + ".", "", onName);
    }
    function onName(name) {
      if (!name) return;
      if (name in tree) return doPrompt();
      entry = tree[name] = { mode: mode, hash: null };
      if (mode === modes.tree) {
        openPaths[path + "/" + name] = true;
        prefs.set("openPaths", openPaths);
      }
      repo.saveAs(type, value, onHash);
    }
    function onHash(err, hash) {
      if (err) throw err;
      entry.hash = hash;
      saveTree(chain);
    }
  }

  function createFile(node) {
    createNode(node.path, modes.blob, "blob", "", "file");
  }

  function createFolder(node) {
    createNode(node.path, modes.tree, "tree", {}, "folder");
  }

  function createSymLink(node) {
    createNode(node.path, modes.sym, "blob", "", "sym-link");
  }

  function toggleExec(node) {
    getChain(node.path, function (err, chain) {
      if (err) throw err;
      var entry = chain.pop();
      var name = entry.name;
      var mode = entry.mode === modes.exec ? modes.blob : modes.exec;
      chain[chain.length - 1].tree[name].mode = mode;
      saveTree(chain);
    });
  }

  function renameNode(node) {
    getChain(node.path, function (err, chain) {
      if (err) throw err;
      var entry = chain.pop();
      var oldName = entry.name;
      var label = getType(node);
      var parent = chain[chain.length - 1];
      if (parent.commit) {
        // TODO: properly clean up submodule data
        // find local path and update submodule link in parent repo
        chain.pop();
        parent = chain[chain.length - 1];
      }
      var tree = parent.tree;
      doPrompt();
      function doPrompt() {
        dialog.prompt("Enter new name for " + label + ".", oldName, onName);
      }
      function onName(name) {
        if (!name || name === oldName) return;
        if (name in tree) return doPrompt();
        tree[name] = tree[oldName];
        delete tree[oldName];
        var newPath = node.path.substr(0, node.path.lastIndexOf("/") + 1) + name;
        updatePaths(makePrefix(node.path), newPath);
        saveTree(chain, function (err, hash) {
          if (err) throw err;
          var doc = docPaths[newPath];
          if (!doc) return;
          doc.setMode(modelist.getModeForPath(name).mode);
          doc.path = newPath;
          doc.updateTitle();
          console.log("RENAME", node.path, newPath, hash);
        });
      }
    });
  }

  function removeNode(node) {
    var message = "Delete " + getType(node) + " '" + getName(node.path) + "'?";

    dialog.confirm(message, function (confirm) {
      if (!confirm) return;
      getChain(node.path, onChain);
    });

    function onChain(err, chain) {
      if (err) throw err;
      var name = chain.pop().name;
      var parent = chain[chain.length - 1];
      if (parent.commit) {
        // TODO: properly clean up submodule data
        // find local path and remove submodule link in parent repo
        // find full path and remove global link to repo
        chain.pop();
        parent = chain[chain.length - 1];
      }
      delete parent.tree[name];
      return saveTree(chain);
    }
  }

  function renameRoot(node) {
    dialog.prompt("Enter new name for repository.", node.path, function (name) {
      if (!name || name === node.path) return;
      roots[name] = roots[node.path];
      delete roots[node.path];
      updatePaths(makePrefix(node.path), name);
      refresh();
    });
  }

  function updatePaths(old, name) {
    migrate(repos, old, name);
    migrate(docPaths, old, name);
    migrate(openPaths, old, name);
    prefs.set("openPaths", openPaths);
    if (old.test(selectedPath)) {
      selectedPath = selectedPath.replace(old, name);
    }
    if (old.test(activePath)) {
      activePath = activePath.replace(old, name);
    }
  }

  function migrate(obj, old, name) {
    Object.keys(obj).forEach(function (key) {
      if (!old.test(key)) return;
      var newKey = key.replace(old, name);
      obj[newKey] = obj[key];
      delete obj[key];
    });
  }


  function removeRoot(node) {
    var message = "Remove repository '" + node.path + "'?";

    dialog.confirm(message, function (confirm) {
      if (!confirm) return;
      delete roots[node.path];
      // TODO: clean up other paths
      refresh();
    });
  }

  function makePrefix(path) {
    // TODO: escape special regex characters in path
    return new RegExp("^" + path + "(?=/|$)");
  }

  function onContextMenu(evt) {
    var node = findJs(evt.target);
    evt.preventDefault();
    evt.stopPropagation();
    var actions = [];
    if (node) {
      var mode = parseInt(node.mode, 8);
      var type;
      actions.push({icon:"globe", label:"Serve Over HTTP"});
      actions.push({icon:"hdd", label:"Live Export to Disk"});
      if (node.commitHash) {
        var repo = findRepo(node.path);
        if (repo.head !== node.commitHash) {
          actions.push({sep:true});
          actions.push({icon:"floppy", label:"Commit Changes"});
          actions.push({icon:"ccw", label:"Revert all Changes", action: revertChanges});
        }
        actions.push({sep:true});
        actions.push({icon:"download-cloud", label:"Pull from Remote"});
        actions.push({icon:"upload-cloud", label:"Push to Remote"});
      }
      if (mode === modes.tree) {
        type = node.commitHash ? "Submodule" : "Folder";
        if (openPaths[node.path]) {
          actions.push({sep:true});
          actions.push({icon:"doc", label:"Create File", action: createFile});
          actions.push({icon:"folder", label:"Create Folder", action: createFolder});
          actions.push({icon:"link", label:"Create SymLink", action: createSymLink});
          actions.push({sep:true});
          actions.push({icon:"fork", label: "Add Submodule"});
          actions.push({icon:"folder", label:"Import Folder"});
          actions.push({icon:"docs", label:"Import File(s)"});
        }
      }
      else if (modes.isFile(mode)) {
        type = "File";
        actions.push({sep:true});
        var label = (mode === modes.exec) ?
          "Make not Executable" :
          "Make Executable";
        actions.push({icon:"asterisk", label: label, action: toggleExec});
      }
      else if (mode === modes.sym) {
        type = "SymLink";
      }
      actions.push({sep:true});
      if (node.path.indexOf("/") >= 0) {
        actions.push({icon:"pencil", label:"Rename " + type, action: renameNode});
        actions.push({icon:"trash", label:"Delete " + type, action: removeNode});
      }
      else {
        actions.push({icon:"pencil", label:"Rename Repo", action: renameRoot});
        actions.push({icon:"trash", label:"Remove Repo", action: removeRoot});
      }
    }
    else {
      actions.push({icon:"git", label: "Create Empty Git Repo"});
      actions.push({icon:"hdd", label:"Create Repo From Folder"});
      actions.push({icon:"fork", label: "Clone Remote Repo"});
      actions.push({icon:"github", label: "Live Mount Github Repo"});
    }

    if (!actions.length) return;
    evt.preventDefault();
    evt.stopPropagation();
    contextMenu(evt, node, actions);
  }

});