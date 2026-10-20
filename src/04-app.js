
/* ===== Mozilla Readability（内联，避免加载失败） ===== */
/*
 * Copyright (c) 2010 Arc90 Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This code is heavily based on Arc90's readability.js (1.7.1) script
 * available at: http://code.google.com/p/arc90labs-readability
 */

/**
 * Public constructor.
 * @param {HTMLDocument} doc     The document to parse.
 * @param {Object}       options The options object.
 */
function Readability(doc, options) {
  // In some older versions, people passed a URI as the first argument. Cope:
  if (options && options.documentElement) {
    doc = options;
    options = arguments[2];
  } else if (!doc || !doc.documentElement) {
    throw new Error("First argument to Readability constructor should be a document object.");
  }
  options = options || {};

  this._doc = doc;
  this._docJSDOMParser = this._doc.firstChild.__JSDOMParser__;
  this._articleTitle = null;
  this._articleByline = null;
  this._articleDir = null;
  this._articleSiteName = null;
  this._attempts = [];

  // Configurable options
  this._debug = !!options.debug;
  this._maxElemsToParse = options.maxElemsToParse || this.DEFAULT_MAX_ELEMS_TO_PARSE;
  this._nbTopCandidates = options.nbTopCandidates || this.DEFAULT_N_TOP_CANDIDATES;
  this._charThreshold = options.charThreshold || this.DEFAULT_CHAR_THRESHOLD;
  this._classesToPreserve = this.CLASSES_TO_PRESERVE.concat(options.classesToPreserve || []);
  this._keepClasses = !!options.keepClasses;
  this._serializer = options.serializer || function(el) {
    return el.innerHTML;
  };
  this._disableJSONLD = !!options.disableJSONLD;
  this._allowedVideoRegex = options.allowedVideoRegex || this.REGEXPS.videos;

  // Start with all flags set
  this._flags = this.FLAG_STRIP_UNLIKELYS |
                this.FLAG_WEIGHT_CLASSES |
                this.FLAG_CLEAN_CONDITIONALLY;


  // Control whether log messages are sent to the console
  if (this._debug) {
    let logNode = function(node) {
      if (node.nodeType == node.TEXT_NODE) {
        return `${node.nodeName} ("${node.textContent}")`;
      }
      let attrPairs = Array.from(node.attributes || [], function(attr) {
        return `${attr.name}="${attr.value}"`;
      }).join(" ");
      return `<${node.localName} ${attrPairs}>`;
    };
    this.log = function () {
      if (typeof console !== "undefined") {
        let args = Array.from(arguments, arg => {
          if (arg && arg.nodeType == this.ELEMENT_NODE) {
            return logNode(arg);
          }
          return arg;
        });
        args.unshift("Reader: (Readability)");
        console.log.apply(console, args);
      } else if (typeof dump !== "undefined") {
        /* global dump */
        var msg = Array.prototype.map.call(arguments, function(x) {
          return (x && x.nodeName) ? logNode(x) : x;
        }).join(" ");
        dump("Reader: (Readability) " + msg + "\n");
      }
    };
  } else {
    this.log = function () {};
  }
}

Readability.prototype = {
  FLAG_STRIP_UNLIKELYS: 0x1,
  FLAG_WEIGHT_CLASSES: 0x2,
  FLAG_CLEAN_CONDITIONALLY: 0x4,

  // https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,

  // Max number of nodes supported by this parser. Default: 0 (no limit)
  DEFAULT_MAX_ELEMS_TO_PARSE: 0,

  // The number of top candidates to consider when analysing how
  // tight the competition is among candidates.
  DEFAULT_N_TOP_CANDIDATES: 5,

  // Element tags to score by default.
  DEFAULT_TAGS_TO_SCORE: "section,h2,h3,h4,h5,h6,p,td,pre".toUpperCase().split(","),

  // The default number of chars an article must have in order to return a result
  DEFAULT_CHAR_THRESHOLD: 500,

  // All of the regular expressions in use within readability.
  // Defined up here so we don't instantiate them repeatedly in loops.
  REGEXPS: {
    // NOTE: These two regular expressions are duplicated in
    // Readability-readerable.js. Please keep both copies in sync.
    unlikelyCandidates: /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
    okMaybeItsACandidate: /and|article|body|column|content|main|shadow/i,

    positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative: /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i,
    extraneous: /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single|utility/i,
    byline: /byline|author|dateline|writtenby|p-author/i,
    replaceFonts: /<(\/?)font[^>]*>/gi,
    normalize: /\s{2,}/g,
    videos: /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
    shareElements: /(\b|_)(share|sharedaddy)(\b|_)/i,
    nextLink: /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i,
    prevLink: /(prev|earl|old|new|<|«)/i,
    tokenize: /\W+/g,
    whitespace: /^\s*$/,
    hasContent: /\S$/,
    hashUrl: /^#.+/,
    srcsetUrl: /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g,
    b64DataUrl: /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i,
    // Commas as used in Latin, Sindhi, Chinese and various other scripts.
    // see: https://en.wikipedia.org/wiki/Comma#Comma_variants
    commas: /\u002C|\u060C|\uFE50|\uFE10|\uFE11|\u2E41|\u2E34|\u2E32|\uFF0C/g,
    // See: https://schema.org/Article
    jsonLdArticleTypes: /^Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference$/
  },

  UNLIKELY_ROLES: [ "menu", "menubar", "complementary", "navigation", "alert", "alertdialog", "dialog" ],

  DIV_TO_P_ELEMS: new Set([ "BLOCKQUOTE", "DL", "DIV", "IMG", "OL", "P", "PRE", "TABLE", "UL" ]),

  ALTER_TO_DIV_EXCEPTIONS: ["DIV", "ARTICLE", "SECTION", "P"],

  PRESENTATIONAL_ATTRIBUTES: [ "align", "background", "bgcolor", "border", "cellpadding", "cellspacing", "frame", "hspace", "rules", "style", "valign", "vspace" ],

  DEPRECATED_SIZE_ATTRIBUTE_ELEMS: [ "TABLE", "TH", "TD", "HR", "PRE" ],

  // The commented out elements qualify as phrasing content but tend to be
  // removed by readability when put into paragraphs, so we ignore them here.
  PHRASING_ELEMS: [
    // "CANVAS", "IFRAME", "SVG", "VIDEO",
    "ABBR", "AUDIO", "B", "BDO", "BR", "BUTTON", "CITE", "CODE", "DATA",
    "DATALIST", "DFN", "EM", "EMBED", "I", "IMG", "INPUT", "KBD", "LABEL",
    "MARK", "MATH", "METER", "NOSCRIPT", "OBJECT", "OUTPUT", "PROGRESS", "Q",
    "RUBY", "SAMP", "SCRIPT", "SELECT", "SMALL", "SPAN", "STRONG", "SUB",
    "SUP", "TEXTAREA", "TIME", "VAR", "WBR"
  ],

  // These are the classes that readability sets itself.
  CLASSES_TO_PRESERVE: [ "page" ],

  // These are the list of HTML entities that need to be escaped.
  HTML_ESCAPE_MAP: {
    "lt": "<",
    "gt": ">",
    "amp": "&",
    "quot": '"',
    "apos": "'",
  },

  /**
   * Run any post-process modifications to article content as necessary.
   *
   * @param Element
   * @return void
  **/
  _postProcessContent: function(articleContent) {
    // Readability cannot open relative uris so we convert them to absolute uris.
    this._fixRelativeUris(articleContent);

    this._simplifyNestedElements(articleContent);

    if (!this._keepClasses) {
      // Remove classes.
      this._cleanClasses(articleContent);
    }
  },

  /**
   * Iterates over a NodeList, calls `filterFn` for each node and removes node
   * if function returned `true`.
   *
   * If function is not passed, removes all the nodes in node list.
   *
   * @param NodeList nodeList The nodes to operate on
   * @param Function filterFn the function to use as a filter
   * @return void
   */
  _removeNodes: function(nodeList, filterFn) {
    // Avoid ever operating on live node lists.
    if (this._docJSDOMParser && nodeList._isLiveNodeList) {
      throw new Error("Do not pass live node lists to _removeNodes");
    }
    for (var i = nodeList.length - 1; i >= 0; i--) {
      var node = nodeList[i];
      var parentNode = node.parentNode;
      if (parentNode) {
        if (!filterFn || filterFn.call(this, node, i, nodeList)) {
          parentNode.removeChild(node);
        }
      }
    }
  },

  /**
   * Iterates over a NodeList, and calls _setNodeTag for each node.
   *
   * @param NodeList nodeList The nodes to operate on
   * @param String newTagName the new tag name to use
   * @return void
   */
  _replaceNodeTags: function(nodeList, newTagName) {
    // Avoid ever operating on live node lists.
    if (this._docJSDOMParser && nodeList._isLiveNodeList) {
      throw new Error("Do not pass live node lists to _replaceNodeTags");
    }
    for (const node of nodeList) {
      this._setNodeTag(node, newTagName);
    }
  },

  /**
   * Iterate over a NodeList, which doesn't natively fully implement the Array
   * interface.
   *
   * For convenience, the current object context is applied to the provided
   * iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return void
   */
  _forEachNode: function(nodeList, fn) {
    Array.prototype.forEach.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, and return the first node that passes
   * the supplied test function
   *
   * For convenience, the current object context is applied to the provided
   * test function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The test function.
   * @return void
   */
  _findNode: function(nodeList, fn) {
    return Array.prototype.find.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, return true if any of the provided iterate
   * function calls returns true, false otherwise.
   *
   * For convenience, the current object context is applied to the
   * provided iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return Boolean
   */
  _someNode: function(nodeList, fn) {
    return Array.prototype.some.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, return true if all of the provided iterate
   * function calls return true, false otherwise.
   *
   * For convenience, the current object context is applied to the
   * provided iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return Boolean
   */
  _everyNode: function(nodeList, fn) {
    return Array.prototype.every.call(nodeList, fn, this);
  },

  /**
   * Concat all nodelists passed as arguments.
   *
   * @return ...NodeList
   * @return Array
   */
  _concatNodeLists: function() {
    var slice = Array.prototype.slice;
    var args = slice.call(arguments);
    var nodeLists = args.map(function(list) {
      return slice.call(list);
    });
    return Array.prototype.concat.apply([], nodeLists);
  },

  _getAllNodesWithTag: function(node, tagNames) {
    if (node.querySelectorAll) {
      return node.querySelectorAll(tagNames.join(","));
    }
    return [].concat.apply([], tagNames.map(function(tag) {
      var collection = node.getElementsByTagName(tag);
      return Array.isArray(collection) ? collection : Array.from(collection);
    }));
  },

  /**
   * Removes the class="" attribute from every element in the given
   * subtree, except those that match CLASSES_TO_PRESERVE and
   * the classesToPreserve array from the options object.
   *
   * @param Element
   * @return void
   */
  _cleanClasses: function(node) {
    var classesToPreserve = this._classesToPreserve;
    var className = (node.getAttribute("class") || "")
      .split(/\s+/)
      .filter(function(cls) {
        return classesToPreserve.indexOf(cls) != -1;
      })
      .join(" ");

    if (className) {
      node.setAttribute("class", className);
    } else {
      node.removeAttribute("class");
    }

    for (node = node.firstElementChild; node; node = node.nextElementSibling) {
      this._cleanClasses(node);
    }
  },

  /**
   * Converts each <a> and <img> uri in the given element to an absolute URI,
   * ignoring #ref URIs.
   *
   * @param Element
   * @return void
   */
  _fixRelativeUris: function(articleContent) {
    var baseURI = this._doc.baseURI;
    var documentURI = this._doc.documentURI;
    function toAbsoluteURI(uri) {
      // Leave hash links alone if the base URI matches the document URI:
      if (baseURI == documentURI && uri.charAt(0) == "#") {
        return uri;
      }

      // Otherwise, resolve against base URI:
      try {
        return new URL(uri, baseURI).href;
      } catch (ex) {
        // Something went wrong, just return the original:
      }
      return uri;
    }

    var links = this._getAllNodesWithTag(articleContent, ["a"]);
    this._forEachNode(links, function(link) {
      var href = link.getAttribute("href");
      if (href) {
        // Remove links with javascript: URIs, since
        // they won't work after scripts have been removed from the page.
        if (href.indexOf("javascript:") === 0) {
          // if the link only contains simple text content, it can be converted to a text node
          if (link.childNodes.length === 1 && link.childNodes[0].nodeType === this.TEXT_NODE) {
            var text = this._doc.createTextNode(link.textContent);
            link.parentNode.replaceChild(text, link);
          } else {
            // if the link has multiple children, they should all be preserved
            var container = this._doc.createElement("span");
            while (link.firstChild) {
              container.appendChild(link.firstChild);
            }
            link.parentNode.replaceChild(container, link);
          }
        } else {
          link.setAttribute("href", toAbsoluteURI(href));
        }
      }
    });

    var medias = this._getAllNodesWithTag(articleContent, [
      "img", "picture", "figure", "video", "audio", "source"
    ]);

    this._forEachNode(medias, function(media) {
      var src = media.getAttribute("src");
      var poster = media.getAttribute("poster");
      var srcset = media.getAttribute("srcset");

      if (src) {
        media.setAttribute("src", toAbsoluteURI(src));
      }

      if (poster) {
        media.setAttribute("poster", toAbsoluteURI(poster));
      }

      if (srcset) {
        var newSrcset = srcset.replace(this.REGEXPS.srcsetUrl, function(_, p1, p2, p3) {
          return toAbsoluteURI(p1) + (p2 || "") + p3;
        });

        media.setAttribute("srcset", newSrcset);
      }
    });
  },

  _simplifyNestedElements: function(articleContent) {
    var node = articleContent;

    while (node) {
      if (node.parentNode && ["DIV", "SECTION"].includes(node.tagName) && !(node.id && node.id.startsWith("readability"))) {
        if (this._isElementWithoutContent(node)) {
          node = this._removeAndGetNext(node);
          continue;
        } else if (this._hasSingleTagInsideElement(node, "DIV") || this._hasSingleTagInsideElement(node, "SECTION")) {
          var child = node.children[0];
          for (var i = 0; i < node.attributes.length; i++) {
            child.setAttribute(node.attributes[i].name, node.attributes[i].value);
          }
          node.parentNode.replaceChild(child, node);
          node = child;
          continue;
        }
      }

      node = this._getNextNode(node);
    }
  },

  /**
   * Get the article title as an H1.
   *
   * @return string
   **/
  _getArticleTitle: function() {
    var doc = this._doc;
    var curTitle = "";
    var origTitle = "";

    try {
      curTitle = origTitle = doc.title.trim();

      // If they had an element with id "title" in their HTML
      if (typeof curTitle !== "string")
        curTitle = origTitle = this._getInnerText(doc.getElementsByTagName("title")[0]);
    } catch (e) {/* ignore exceptions setting the title. */}

    var titleHadHierarchicalSeparators = false;
    function wordCount(str) {
      return str.split(/\s+/).length;
    }

    // If there's a separator in the title, first remove the final part
    if ((/ [\|\-\\\/>»] /).test(curTitle)) {
      titleHadHierarchicalSeparators = / [\\\/>»] /.test(curTitle);
      curTitle = origTitle.replace(/(.*)[\|\-\\\/>»] .*/gi, "$1");

      // If the resulting title is too short (3 words or fewer), remove
      // the first part instead:
      if (wordCount(curTitle) < 3)
        curTitle = origTitle.replace(/[^\|\-\\\/>»]*[\|\-\\\/>»](.*)/gi, "$1");
    } else if (curTitle.indexOf(": ") !== -1) {
      // Check if we have an heading containing this exact string, so we
      // could assume it's the full title.
      var headings = this._concatNodeLists(
        doc.getElementsByTagName("h1"),
        doc.getElementsByTagName("h2")
      );
      var trimmedTitle = curTitle.trim();
      var match = this._someNode(headings, function(heading) {
        return heading.textContent.trim() === trimmedTitle;
      });

      // If we don't, let's extract the title out of the original title string.
      if (!match) {
        curTitle = origTitle.substring(origTitle.lastIndexOf(":") + 1);

        // If the title is now too short, try the first colon instead:
        if (wordCount(curTitle) < 3) {
          curTitle = origTitle.substring(origTitle.indexOf(":") + 1);
          // But if we have too many words before the colon there's something weird
          // with the titles and the H tags so let's just use the original title instead
        } else if (wordCount(origTitle.substr(0, origTitle.indexOf(":"))) > 5) {
          curTitle = origTitle;
        }
      }
    } else if (curTitle.length > 150 || curTitle.length < 15) {
      var hOnes = doc.getElementsByTagName("h1");

      if (hOnes.length === 1)
        curTitle = this._getInnerText(hOnes[0]);
    }

    curTitle = curTitle.trim().replace(this.REGEXPS.normalize, " ");
    // If we now have 4 words or fewer as our title, and either no
    // 'hierarchical' separators (\, /, > or ») were found in the original
    // title or we decreased the number of words by more than 1 word, use
    // the original title.
    var curTitleWordCount = wordCount(curTitle);
    if (curTitleWordCount <= 4 &&
        (!titleHadHierarchicalSeparators ||
         curTitleWordCount != wordCount(origTitle.replace(/[\|\-\\\/>»]+/g, "")) - 1)) {
      curTitle = origTitle;
    }

    return curTitle;
  },

  /**
   * Prepare the HTML document for readability to scrape it.
   * This includes things like stripping javascript, CSS, and handling terrible markup.
   *
   * @return void
   **/
  _prepDocument: function() {
    var doc = this._doc;

    // Remove all style tags in head
    this._removeNodes(this._getAllNodesWithTag(doc, ["style"]));

    if (doc.body) {
      this._replaceBrs(doc.body);
    }

    this._replaceNodeTags(this._getAllNodesWithTag(doc, ["font"]), "SPAN");
  },

  /**
   * Finds the next node, starting from the given node, and ignoring
   * whitespace in between. If the given node is an element, the same node is
   * returned.
   */
  _nextNode: function (node) {
    var next = node;
    while (next
        && (next.nodeType != this.ELEMENT_NODE)
        && this.REGEXPS.whitespace.test(next.textContent)) {
      next = next.nextSibling;
    }
    return next;
  },

  /**
   * Replaces 2 or more successive <br> elements with a single <p>.
   * Whitespace between <br> elements are ignored. For example:
   *   <div>foo<br>bar<br> <br><br>abc</div>
   * will become:
   *   <div>foo<br>bar<p>abc</p></div>
   */
  _replaceBrs: function (elem) {
    this._forEachNode(this._getAllNodesWithTag(elem, ["br"]), function(br) {
      var next = br.nextSibling;

      // Whether 2 or more <br> elements have been found and replaced with a
      // <p> block.
      var replaced = false;

      // If we find a <br> chain, remove the <br>s until we hit another node
      // or non-whitespace. This leaves behind the first <br> in the chain
      // (which will be replaced with a <p> later).
      while ((next = this._nextNode(next)) && (next.tagName == "BR")) {
        replaced = true;
        var brSibling = next.nextSibling;
        next.parentNode.removeChild(next);
        next = brSibling;
      }

      // If we removed a <br> chain, replace the remaining <br> with a <p>. Add
      // all sibling nodes as children of the <p> until we hit another <br>
      // chain.
      if (replaced) {
        var p = this._doc.createElement("p");
        br.parentNode.replaceChild(p, br);

        next = p.nextSibling;
        while (next) {
          // If we've hit another <br><br>, we're done adding children to this <p>.
          if (next.tagName == "BR") {
            var nextElem = this._nextNode(next.nextSibling);
            if (nextElem && nextElem.tagName == "BR")
              break;
          }

          if (!this._isPhrasingContent(next))
            break;

          // Otherwise, make this node a child of the new <p>.
          var sibling = next.nextSibling;
          p.appendChild(next);
          next = sibling;
        }

        while (p.lastChild && this._isWhitespace(p.lastChild)) {
          p.removeChild(p.lastChild);
        }

        if (p.parentNode.tagName === "P")
          this._setNodeTag(p.parentNode, "DIV");
      }
    });
  },

  _setNodeTag: function (node, tag) {
    this.log("_setNodeTag", node, tag);
    if (this._docJSDOMParser) {
      node.localName = tag.toLowerCase();
      node.tagName = tag.toUpperCase();
      return node;
    }

    var replacement = node.ownerDocument.createElement(tag);
    while (node.firstChild) {
      replacement.appendChild(node.firstChild);
    }
    node.parentNode.replaceChild(replacement, node);
    if (node.readability)
      replacement.readability = node.readability;

    for (var i = 0; i < node.attributes.length; i++) {
      try {
        replacement.setAttribute(node.attributes[i].name, node.attributes[i].value);
      } catch (ex) {
        /* it's possible for setAttribute() to throw if the attribute name
         * isn't a valid XML Name. Such attributes can however be parsed from
         * source in HTML docs, see https://github.com/whatwg/html/issues/4275,
         * so we can hit them here and then throw. We don't care about such
         * attributes so we ignore them.
         */
      }
    }
    return replacement;
  },

  /**
   * Prepare the article node for display. Clean out any inline styles,
   * iframes, forms, strip extraneous <p> tags, etc.
   *
   * @param Element
   * @return void
   **/
  _prepArticle: function(articleContent) {
    this._cleanStyles(articleContent);

    // Check for data tables before we continue, to avoid removing items in
    // those tables, which will often be isolated even though they're
    // visually linked to other content-ful elements (text, images, etc.).
    this._markDataTables(articleContent);

    this._fixLazyImages(articleContent);

    // Clean out junk from the article content
    this._cleanConditionally(articleContent, "form");
    this._cleanConditionally(articleContent, "fieldset");
    this._clean(articleContent, "object");
    this._clean(articleContent, "embed");
    this._clean(articleContent, "footer");
    this._clean(articleContent, "link");
    this._clean(articleContent, "aside");

    // Clean out elements with little content that have "share" in their id/class combinations from final top candidates,
    // which means we don't remove the top candidates even they have "share".

    var shareElementThreshold = this.DEFAULT_CHAR_THRESHOLD;

    this._forEachNode(articleContent.children, function (topCandidate) {
      this._cleanMatchedNodes(topCandidate, function (node, matchString) {
        return this.REGEXPS.shareElements.test(matchString) && node.textContent.length < shareElementThreshold;
      });
    });

    this._clean(articleContent, "iframe");
    this._clean(articleContent, "input");
    this._clean(articleContent, "textarea");
    this._clean(articleContent, "select");
    this._clean(articleContent, "button");
    this._cleanHeaders(articleContent);

    // Do these last as the previous stuff may have removed junk
    // that will affect these
    this._cleanConditionally(articleContent, "table");
    this._cleanConditionally(articleContent, "ul");
    this._cleanConditionally(articleContent, "div");

    // replace H1 with H2 as H1 should be only title that is displayed separately
    this._replaceNodeTags(this._getAllNodesWithTag(articleContent, ["h1"]), "h2");

    // Remove extra paragraphs
    this._removeNodes(this._getAllNodesWithTag(articleContent, ["p"]), function (paragraph) {
      var imgCount = paragraph.getElementsByTagName("img").length;
      var embedCount = paragraph.getElementsByTagName("embed").length;
      var objectCount = paragraph.getElementsByTagName("object").length;
      // At this point, nasty iframes have been removed, only remain embedded video ones.
      var iframeCount = paragraph.getElementsByTagName("iframe").length;
      var totalCount = imgCount + embedCount + objectCount + iframeCount;

      return totalCount === 0 && !this._getInnerText(paragraph, false);
    });

    this._forEachNode(this._getAllNodesWithTag(articleContent, ["br"]), function(br) {
      var next = this._nextNode(br.nextSibling);
      if (next && next.tagName == "P")
        br.parentNode.removeChild(br);
    });

    // Remove single-cell tables
    this._forEachNode(this._getAllNodesWithTag(articleContent, ["table"]), function(table) {
      var tbody = this._hasSingleTagInsideElement(table, "TBODY") ? table.firstElementChild : table;
      if (this._hasSingleTagInsideElement(tbody, "TR")) {
        var row = tbody.firstElementChild;
        if (this._hasSingleTagInsideElement(row, "TD")) {
          var cell = row.firstElementChild;
          cell = this._setNodeTag(cell, this._everyNode(cell.childNodes, this._isPhrasingContent) ? "P" : "DIV");
          table.parentNode.replaceChild(cell, table);
        }
      }
    });
  },

  /**
   * Initialize a node with the readability object. Also checks the
   * className/id for special names to add to its score.
   *
   * @param Element
   * @return void
  **/
  _initializeNode: function(node) {
    node.readability = {"contentScore": 0};

    switch (node.tagName) {
      case "DIV":
        node.readability.contentScore += 5;
        break;

      case "PRE":
      case "TD":
      case "BLOCKQUOTE":
        node.readability.contentScore += 3;
        break;

      case "ADDRESS":
      case "OL":
      case "UL":
      case "DL":
      case "DD":
      case "DT":
      case "LI":
      case "FORM":
        node.readability.contentScore -= 3;
        break;

      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
      case "TH":
        node.readability.contentScore -= 5;
        break;
    }

    node.readability.contentScore += this._getClassWeight(node);
  },

  _removeAndGetNext: function(node) {
    var nextNode = this._getNextNode(node, true);
    node.parentNode.removeChild(node);
    return nextNode;
  },

  /**
   * Traverse the DOM from node to node, starting at the node passed in.
   * Pass true for the second parameter to indicate this node itself
   * (and its kids) are going away, and we want the next node over.
   *
   * Calling this in a loop will traverse the DOM depth-first.
   */
  _getNextNode: function(node, ignoreSelfAndKids) {
    // First check for kids if those aren't being ignored
    if (!ignoreSelfAndKids && node.firstElementChild) {
      return node.firstElementChild;
    }
    // Then for siblings...
    if (node.nextElementSibling) {
      return node.nextElementSibling;
    }
    // And finally, move up the parent chain *and* find a sibling
    // (because this is depth-first traversal, we will have already
    // seen the parent nodes themselves).
    do {
      node = node.parentNode;
    } while (node && !node.nextElementSibling);
    return node && node.nextElementSibling;
  },

  // compares second text to first one
  // 1 = same text, 0 = completely different text
  // works the way that it splits both texts into words and then finds words that are unique in second text
  // the result is given by the lower length of unique parts
  _textSimilarity: function(textA, textB) {
    var tokensA = textA.toLowerCase().split(this.REGEXPS.tokenize).filter(Boolean);
    var tokensB = textB.toLowerCase().split(this.REGEXPS.tokenize).filter(Boolean);
    if (!tokensA.length || !tokensB.length) {
      return 0;
    }
    var uniqTokensB = tokensB.filter(token => !tokensA.includes(token));
    var distanceB = uniqTokensB.join(" ").length / tokensB.join(" ").length;
    return 1 - distanceB;
  },

  _checkByline: function(node, matchString) {
    if (this._articleByline) {
      return false;
    }

    if (node.getAttribute !== undefined) {
      var rel = node.getAttribute("rel");
      var itemprop = node.getAttribute("itemprop");
    }

    if ((rel === "author" || (itemprop && itemprop.indexOf("author") !== -1) || this.REGEXPS.byline.test(matchString)) && this._isValidByline(node.textContent)) {
      this._articleByline = node.textContent.trim();
      return true;
    }

    return false;
  },

  _getNodeAncestors: function(node, maxDepth) {
    maxDepth = maxDepth || 0;
    var i = 0, ancestors = [];
    while (node.parentNode) {
      ancestors.push(node.parentNode);
      if (maxDepth && ++i === maxDepth)
        break;
      node = node.parentNode;
    }
    return ancestors;
  },

  /***
   * grabArticle - Using a variety of metrics (content score, classname, element types), find the content that is
   *         most likely to be the stuff a user wants to read. Then return it wrapped up in a div.
   *
   * @param page a document to run upon. Needs to be a full document, complete with body.
   * @return Element
  **/
  _grabArticle: function (page) {
    this.log("**** grabArticle ****");
    var doc = this._doc;
    var isPaging = page !== null;
    page = page ? page : this._doc.body;

    // We can't grab an article if we don't have a page!
    if (!page) {
      this.log("No body found in document. Abort.");
      return null;
    }

    var pageCacheHtml = page.innerHTML;

    while (true) {
      this.log("Starting grabArticle loop");
      var stripUnlikelyCandidates = this._flagIsActive(this.FLAG_STRIP_UNLIKELYS);

      // First, node prepping. Trash nodes that look cruddy (like ones with the
      // class name "comment", etc), and turn divs into P tags where they have been
      // used inappropriately (as in, where they contain no other block level elements.)
      var elementsToScore = [];
      var node = this._doc.documentElement;

      let shouldRemoveTitleHeader = true;

      while (node) {

        if (node.tagName === "HTML") {
          this._articleLang = node.getAttribute("lang");
        }

        var matchString = node.className + " " + node.id;

        if (!this._isProbablyVisible(node)) {
          this.log("Removing hidden node - " + matchString);
          node = this._removeAndGetNext(node);
          continue;
        }

        // User is not able to see elements applied with both "aria-modal = true" and "role = dialog"
        if (node.getAttribute("aria-modal") == "true" && node.getAttribute("role") == "dialog") {
          node = this._removeAndGetNext(node);
          continue;
        }

        // Check to see if this node is a byline, and remove it if it is.
        if (this._checkByline(node, matchString)) {
          node = this._removeAndGetNext(node);
          continue;
        }

        if (shouldRemoveTitleHeader && this._headerDuplicatesTitle(node)) {
          this.log("Removing header: ", node.textContent.trim(), this._articleTitle.trim());
          shouldRemoveTitleHeader = false;
          node = this._removeAndGetNext(node);
          continue;
        }

        // Remove unlikely candidates
        if (stripUnlikelyCandidates) {
          if (this.REGEXPS.unlikelyCandidates.test(matchString) &&
              !this.REGEXPS.okMaybeItsACandidate.test(matchString) &&
              !this._hasAncestorTag(node, "table") &&
              !this._hasAncestorTag(node, "code") &&
              node.tagName !== "BODY" &&
              node.tagName !== "A") {
            this.log("Removing unlikely candidate - " + matchString);
            node = this._removeAndGetNext(node);
            continue;
          }

          if (this.UNLIKELY_ROLES.includes(node.getAttribute("role"))) {
            this.log("Removing content with role " + node.getAttribute("role") + " - " + matchString);
            node = this._removeAndGetNext(node);
            continue;
          }
        }

        // Remove DIV, SECTION, and HEADER nodes without any content(e.g. text, image, video, or iframe).
        if ((node.tagName === "DIV" || node.tagName === "SECTION" || node.tagName === "HEADER" ||
             node.tagName === "H1" || node.tagName === "H2" || node.tagName === "H3" ||
             node.tagName === "H4" || node.tagName === "H5" || node.tagName === "H6") &&
            this._isElementWithoutContent(node)) {
          node = this._removeAndGetNext(node);
          continue;
        }

        if (this.DEFAULT_TAGS_TO_SCORE.indexOf(node.tagName) !== -1) {
          elementsToScore.push(node);
        }

        // Turn all divs that don't have children block level elements into p's
        if (node.tagName === "DIV") {
          // Put phrasing content into paragraphs.
          var p = null;
          var childNode = node.firstChild;
          while (childNode) {
            var nextSibling = childNode.nextSibling;
            if (this._isPhrasingContent(childNode)) {
              if (p !== null) {
                p.appendChild(childNode);
              } else if (!this._isWhitespace(childNode)) {
                p = doc.createElement("p");
                node.replaceChild(p, childNode);
                p.appendChild(childNode);
              }
            } else if (p !== null) {
              while (p.lastChild && this._isWhitespace(p.lastChild)) {
                p.removeChild(p.lastChild);
              }
              p = null;
            }
            childNode = nextSibling;
          }

          // Sites like http://mobile.slate.com encloses each paragraph with a DIV
          // element. DIVs with only a P element inside and no text content can be
          // safely converted into plain P elements to avoid confusing the scoring
          // algorithm with DIVs with are, in practice, paragraphs.
          if (this._hasSingleTagInsideElement(node, "P") && this._getLinkDensity(node) < 0.25) {
            var newNode = node.children[0];
            node.parentNode.replaceChild(newNode, node);
            node = newNode;
            elementsToScore.push(node);
          } else if (!this._hasChildBlockElement(node)) {
            node = this._setNodeTag(node, "P");
            elementsToScore.push(node);
          }
        }
        node = this._getNextNode(node);
      }

      /**
       * Loop through all paragraphs, and assign a score to them based on how content-y they look.
       * Then add their score to their parent node.
       *
       * A score is determined by things like number of commas, class names, etc. Maybe eventually link density.
      **/
      var candidates = [];
      this._forEachNode(elementsToScore, function(elementToScore) {
        if (!elementToScore.parentNode || typeof(elementToScore.parentNode.tagName) === "undefined")
          return;

        // If this paragraph is less than 25 characters, don't even count it.
        var innerText = this._getInnerText(elementToScore);
        if (innerText.length < 25)
          return;

        // Exclude nodes with no ancestor.
        var ancestors = this._getNodeAncestors(elementToScore, 5);
        if (ancestors.length === 0)
          return;

        var contentScore = 0;

        // Add a point for the paragraph itself as a base.
        contentScore += 1;

        // Add points for any commas within this paragraph.
        contentScore += innerText.split(this.REGEXPS.commas).length;

        // For every 100 characters in this paragraph, add another point. Up to 3 points.
        contentScore += Math.min(Math.floor(innerText.length / 100), 3);

        // Initialize and score ancestors.
        this._forEachNode(ancestors, function(ancestor, level) {
          if (!ancestor.tagName || !ancestor.parentNode || typeof(ancestor.parentNode.tagName) === "undefined")
            return;

          if (typeof(ancestor.readability) === "undefined") {
            this._initializeNode(ancestor);
            candidates.push(ancestor);
          }

          // Node score divider:
          // - parent:             1 (no division)
          // - grandparent:        2
          // - great grandparent+: ancestor level * 3
          if (level === 0)
            var scoreDivider = 1;
          else if (level === 1)
            scoreDivider = 2;
          else
            scoreDivider = level * 3;
          ancestor.readability.contentScore += contentScore / scoreDivider;
        });
      });

      // After we've calculated scores, loop through all of the possible
      // candidate nodes we found and find the one with the highest score.
      var topCandidates = [];
      for (var c = 0, cl = candidates.length; c < cl; c += 1) {
        var candidate = candidates[c];

        // Scale the final candidates score based on link density. Good content
        // should have a relatively small link density (5% or less) and be mostly
        // unaffected by this operation.
        var candidateScore = candidate.readability.contentScore * (1 - this._getLinkDensity(candidate));
        candidate.readability.contentScore = candidateScore;

        this.log("Candidate:", candidate, "with score " + candidateScore);

        for (var t = 0; t < this._nbTopCandidates; t++) {
          var aTopCandidate = topCandidates[t];

          if (!aTopCandidate || candidateScore > aTopCandidate.readability.contentScore) {
            topCandidates.splice(t, 0, candidate);
            if (topCandidates.length > this._nbTopCandidates)
              topCandidates.pop();
            break;
          }
        }
      }

      var topCandidate = topCandidates[0] || null;
      var neededToCreateTopCandidate = false;
      var parentOfTopCandidate;

      // If we still have no top candidate, just use the body as a last resort.
      // We also have to copy the body node so it is something we can modify.
      if (topCandidate === null || topCandidate.tagName === "BODY") {
        // Move all of the page's children into topCandidate
        topCandidate = doc.createElement("DIV");
        neededToCreateTopCandidate = true;
        // Move everything (not just elements, also text nodes etc.) into the container
        // so we even include text directly in the body:
        while (page.firstChild) {
          this.log("Moving child out:", page.firstChild);
          topCandidate.appendChild(page.firstChild);
        }

        page.appendChild(topCandidate);

        this._initializeNode(topCandidate);
      } else if (topCandidate) {
        // Find a better top candidate node if it contains (at least three) nodes which belong to `topCandidates` array
        // and whose scores are quite closed with current `topCandidate` node.
        var alternativeCandidateAncestors = [];
        for (var i = 1; i < topCandidates.length; i++) {
          if (topCandidates[i].readability.contentScore / topCandidate.readability.contentScore >= 0.75) {
            alternativeCandidateAncestors.push(this._getNodeAncestors(topCandidates[i]));
          }
        }
        var MINIMUM_TOPCANDIDATES = 3;
        if (alternativeCandidateAncestors.length >= MINIMUM_TOPCANDIDATES) {
          parentOfTopCandidate = topCandidate.parentNode;
          while (parentOfTopCandidate.tagName !== "BODY") {
            var listsContainingThisAncestor = 0;
            for (var ancestorIndex = 0; ancestorIndex < alternativeCandidateAncestors.length && listsContainingThisAncestor < MINIMUM_TOPCANDIDATES; ancestorIndex++) {
              listsContainingThisAncestor += Number(alternativeCandidateAncestors[ancestorIndex].includes(parentOfTopCandidate));
            }
            if (listsContainingThisAncestor >= MINIMUM_TOPCANDIDATES) {
              topCandidate = parentOfTopCandidate;
              break;
            }
            parentOfTopCandidate = parentOfTopCandidate.parentNode;
          }
        }
        if (!topCandidate.readability) {
          this._initializeNode(topCandidate);
        }

        // Because of our bonus system, parents of candidates might have scores
        // themselves. They get half of the node. There won't be nodes with higher
        // scores than our topCandidate, but if we see the score going *up* in the first
        // few steps up the tree, that's a decent sign that there might be more content
        // lurking in other places that we want to unify in. The sibling stuff
        // below does some of that - but only if we've looked high enough up the DOM
        // tree.
        parentOfTopCandidate = topCandidate.parentNode;
        var lastScore = topCandidate.readability.contentScore;
        // The scores shouldn't get too low.
        var scoreThreshold = lastScore / 3;
        while (parentOfTopCandidate.tagName !== "BODY") {
          if (!parentOfTopCandidate.readability) {
            parentOfTopCandidate = parentOfTopCandidate.parentNode;
            continue;
          }
          var parentScore = parentOfTopCandidate.readability.contentScore;
          if (parentScore < scoreThreshold)
            break;
          if (parentScore > lastScore) {
            // Alright! We found a better parent to use.
            topCandidate = parentOfTopCandidate;
            break;
          }
          lastScore = parentOfTopCandidate.readability.contentScore;
          parentOfTopCandidate = parentOfTopCandidate.parentNode;
        }

        // If the top candidate is the only child, use parent instead. This will help sibling
        // joining logic when adjacent content is actually located in parent's sibling node.
        parentOfTopCandidate = topCandidate.parentNode;
        while (parentOfTopCandidate.tagName != "BODY" && parentOfTopCandidate.children.length == 1) {
          topCandidate = parentOfTopCandidate;
          parentOfTopCandidate = topCandidate.parentNode;
        }
        if (!topCandidate.readability) {
          this._initializeNode(topCandidate);
        }
      }

      // Now that we have the top candidate, look through its siblings for content
      // that might also be related. Things like preambles, content split by ads
      // that we removed, etc.
      var articleContent = doc.createElement("DIV");
      if (isPaging)
        articleContent.id = "readability-content";

      var siblingScoreThreshold = Math.max(10, topCandidate.readability.contentScore * 0.2);
      // Keep potential top candidate's parent node to try to get text direction of it later.
      parentOfTopCandidate = topCandidate.parentNode;
      var siblings = parentOfTopCandidate.children;

      for (var s = 0, sl = siblings.length; s < sl; s++) {
        var sibling = siblings[s];
        var append = false;

        this.log("Looking at sibling node:", sibling, sibling.readability ? ("with score " + sibling.readability.contentScore) : "");
        this.log("Sibling has score", sibling.readability ? sibling.readability.contentScore : "Unknown");

        if (sibling === topCandidate) {
          append = true;
        } else {
          var contentBonus = 0;

          // Give a bonus if sibling nodes and top candidates have the example same classname
          if (sibling.className === topCandidate.className && topCandidate.className !== "")
            contentBonus += topCandidate.readability.contentScore * 0.2;

          if (sibling.readability &&
              ((sibling.readability.contentScore + contentBonus) >= siblingScoreThreshold)) {
            append = true;
          } else if (sibling.nodeName === "P") {
            var linkDensity = this._getLinkDensity(sibling);
            var nodeContent = this._getInnerText(sibling);
            var nodeLength = nodeContent.length;

            if (nodeLength > 80 && linkDensity < 0.25) {
              append = true;
            } else if (nodeLength < 80 && nodeLength > 0 && linkDensity === 0 &&
                       nodeContent.search(/\.( |$)/) !== -1) {
              append = true;
            }
          }
        }

        if (append) {
          this.log("Appending node:", sibling);

          if (this.ALTER_TO_DIV_EXCEPTIONS.indexOf(sibling.nodeName) === -1) {
            // We have a node that isn't a common block level element, like a form or td tag.
            // Turn it into a div so it doesn't get filtered out later by accident.
            this.log("Altering sibling:", sibling, "to div.");

            sibling = this._setNodeTag(sibling, "DIV");
          }

          articleContent.appendChild(sibling);
          // Fetch children again to make it compatible
          // with DOM parsers without live collection support.
          siblings = parentOfTopCandidate.children;
          // siblings is a reference to the children array, and
          // sibling is removed from the array when we call appendChild().
          // As a result, we must revisit this index since the nodes
          // have been shifted.
          s -= 1;
          sl -= 1;
        }
      }

      if (this._debug)
        this.log("Article content pre-prep: " + articleContent.innerHTML);
      // So we have all of the content that we need. Now we clean it up for presentation.
      this._prepArticle(articleContent);
      if (this._debug)
        this.log("Article content post-prep: " + articleContent.innerHTML);

      if (neededToCreateTopCandidate) {
        // We already created a fake div thing, and there wouldn't have been any siblings left
        // for the previous loop, so there's no point trying to create a new div, and then
        // move all the children over. Just assign IDs and class names here. No need to append
        // because that already happened anyway.
        topCandidate.id = "readability-page-1";
        topCandidate.className = "page";
      } else {
        var div = doc.createElement("DIV");
        div.id = "readability-page-1";
        div.className = "page";
        while (articleContent.firstChild) {
          div.appendChild(articleContent.firstChild);
        }
        articleContent.appendChild(div);
      }

      if (this._debug)
        this.log("Article content after paging: " + articleContent.innerHTML);

      var parseSuccessful = true;

      // Now that we've gone through the full algorithm, check to see if
      // we got any meaningful content. If we didn't, we may need to re-run
      // grabArticle with different flags set. This gives us a higher likelihood of
      // finding the content, and the sieve approach gives us a higher likelihood of
      // finding the -right- content.
      var textLength = this._getInnerText(articleContent, true).length;
      if (textLength < this._charThreshold) {
        parseSuccessful = false;
        page.innerHTML = pageCacheHtml;

        if (this._flagIsActive(this.FLAG_STRIP_UNLIKELYS)) {
          this._removeFlag(this.FLAG_STRIP_UNLIKELYS);
          this._attempts.push({articleContent: articleContent, textLength: textLength});
        } else if (this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
          this._removeFlag(this.FLAG_WEIGHT_CLASSES);
          this._attempts.push({articleContent: articleContent, textLength: textLength});
        } else if (this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
          this._removeFlag(this.FLAG_CLEAN_CONDITIONALLY);
          this._attempts.push({articleContent: articleContent, textLength: textLength});
        } else {
          this._attempts.push({articleContent: articleContent, textLength: textLength});
          // No luck after removing flags, just return the longest text we found during the different loops
          this._attempts.sort(function (a, b) {
            return b.textLength - a.textLength;
          });

          // But first check if we actually have something
          if (!this._attempts[0].textLength) {
            return null;
          }

          articleContent = this._attempts[0].articleContent;
          parseSuccessful = true;
        }
      }

      if (parseSuccessful) {
        // Find out text direction from ancestors of final top candidate.
        var ancestors = [parentOfTopCandidate, topCandidate].concat(this._getNodeAncestors(parentOfTopCandidate));
        this._someNode(ancestors, function(ancestor) {
          if (!ancestor.tagName)
            return false;
          var articleDir = ancestor.getAttribute("dir");
          if (articleDir) {
            this._articleDir = articleDir;
            return true;
          }
          return false;
        });
        return articleContent;
      }
    }
  },

  /**
   * Check whether the input string could be a byline.
   * This verifies that the input is a string, and that the length
   * is less than 100 chars.
   *
   * @param possibleByline {string} - a string to check whether its a byline.
   * @return Boolean - whether the input string is a byline.
   */
  _isValidByline: function(byline) {
    if (typeof byline == "string" || byline instanceof String) {
      byline = byline.trim();
      return (byline.length > 0) && (byline.length < 100);
    }
    return false;
  },

  /**
   * Converts some of the common HTML entities in string to their corresponding characters.
   *
   * @param str {string} - a string to unescape.
   * @return string without HTML entity.
   */
  _unescapeHtmlEntities: function(str) {
    if (!str) {
      return str;
    }

    var htmlEscapeMap = this.HTML_ESCAPE_MAP;
    return str.replace(/&(quot|amp|apos|lt|gt);/g, function(_, tag) {
      return htmlEscapeMap[tag];
    }).replace(/&#(?:x([0-9a-z]{1,4})|([0-9]{1,4}));/gi, function(_, hex, numStr) {
      var num = parseInt(hex || numStr, hex ? 16 : 10);
      return String.fromCharCode(num);
    });
  },

  /**
   * Try to extract metadata from JSON-LD object.
   * For now, only Schema.org objects of type Article or its subtypes are supported.
   * @return Object with any metadata that could be extracted (possibly none)
   */
  _getJSONLD: function (doc) {
    var scripts = this._getAllNodesWithTag(doc, ["script"]);

    var metadata;

    this._forEachNode(scripts, function(jsonLdElement) {
      if (!metadata && jsonLdElement.getAttribute("type") === "application/ld+json") {
        try {
          // Strip CDATA markers if present
          var content = jsonLdElement.textContent.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "");
          var parsed = JSON.parse(content);
          if (
            !parsed["@context"] ||
            !parsed["@context"].match(/^https?\:\/\/schema\.org$/)
          ) {
            return;
          }

          if (!parsed["@type"] && Array.isArray(parsed["@graph"])) {
            parsed = parsed["@graph"].find(function(it) {
              return (it["@type"] || "").match(
                this.REGEXPS.jsonLdArticleTypes
              );
            });
          }

          if (
            !parsed ||
            !parsed["@type"] ||
            !parsed["@type"].match(this.REGEXPS.jsonLdArticleTypes)
          ) {
            return;
          }

          metadata = {};

          if (typeof parsed.name === "string" && typeof parsed.headline === "string" && parsed.name !== parsed.headline) {
            // we have both name and headline element in the JSON-LD. They should both be the same but some websites like aktualne.cz
            // put their own name into "name" and the article title to "headline" which confuses Readability. So we try to check if either
            // "name" or "headline" closely matches the html title, and if so, use that one. If not, then we use "name" by default.

            var title = this._getArticleTitle();
            var nameMatches = this._textSimilarity(parsed.name, title) > 0.75;
            var headlineMatches = this._textSimilarity(parsed.headline, title) > 0.75;

            if (headlineMatches && !nameMatches) {
              metadata.title = parsed.headline;
            } else {
              metadata.title = parsed.name;
            }
          } else if (typeof parsed.name === "string") {
            metadata.title = parsed.name.trim();
          } else if (typeof parsed.headline === "string") {
            metadata.title = parsed.headline.trim();
          }
          if (parsed.author) {
            if (typeof parsed.author.name === "string") {
              metadata.byline = parsed.author.name.trim();
            } else if (Array.isArray(parsed.author) && parsed.author[0] && typeof parsed.author[0].name === "string") {
              metadata.byline = parsed.author
                .filter(function(author) {
                  return author && typeof author.name === "string";
                })
                .map(function(author) {
                  return author.name.trim();
                })
                .join(", ");
            }
          }
          if (typeof parsed.description === "string") {
            metadata.excerpt = parsed.description.trim();
          }
          if (
            parsed.publisher &&
            typeof parsed.publisher.name === "string"
          ) {
            metadata.siteName = parsed.publisher.name.trim();
          }
          if (typeof parsed.datePublished === "string") {
            metadata.datePublished = parsed.datePublished.trim();
          }
          return;
        } catch (err) {
          this.log(err.message);
        }
      }
    });
    return metadata ? metadata : {};
  },

  /**
   * Attempts to get excerpt and byline metadata for the article.
   *
   * @param {Object} jsonld — object containing any metadata that
   * could be extracted from JSON-LD object.
   *
   * @return Object with optional "excerpt" and "byline" properties
   */
  _getArticleMetadata: function(jsonld) {
    var metadata = {};
    var values = {};
    var metaElements = this._doc.getElementsByTagName("meta");

    // property is a space-separated list of values
    var propertyPattern = /\s*(article|dc|dcterm|og|twitter)\s*:\s*(author|creator|description|published_time|title|site_name)\s*/gi;

    // name is a single value
    var namePattern = /^\s*(?:(dc|dcterm|og|twitter|weibo:(article|webpage))\s*[\.:]\s*)?(author|creator|description|title|site_name)\s*$/i;

    // Find description tags.
    this._forEachNode(metaElements, function(element) {
      var elementName = element.getAttribute("name");
      var elementProperty = element.getAttribute("property");
      var content = element.getAttribute("content");
      if (!content) {
        return;
      }
      var matches = null;
      var name = null;

      if (elementProperty) {
        matches = elementProperty.match(propertyPattern);
        if (matches) {
          // Convert to lowercase, and remove any whitespace
          // so we can match below.
          name = matches[0].toLowerCase().replace(/\s/g, "");
          // multiple authors
          values[name] = content.trim();
        }
      }
      if (!matches && elementName && namePattern.test(elementName)) {
        name = elementName;
        if (content) {
          // Convert to lowercase, remove any whitespace, and convert dots
          // to colons so we can match below.
          name = name.toLowerCase().replace(/\s/g, "").replace(/\./g, ":");
          values[name] = content.trim();
        }
      }
    });

    // get title
    metadata.title = jsonld.title ||
                     values["dc:title"] ||
                     values["dcterm:title"] ||
                     values["og:title"] ||
                     values["weibo:article:title"] ||
                     values["weibo:webpage:title"] ||
                     values["title"] ||
                     values["twitter:title"];

    if (!metadata.title) {
      metadata.title = this._getArticleTitle();
    }

    // get author
    metadata.byline = jsonld.byline ||
                      values["dc:creator"] ||
                      values["dcterm:creator"] ||
                      values["author"];

    // get description
    metadata.excerpt = jsonld.excerpt ||
                       values["dc:description"] ||
                       values["dcterm:description"] ||
                       values["og:description"] ||
                       values["weibo:article:description"] ||
                       values["weibo:webpage:description"] ||
                       values["description"] ||
                       values["twitter:description"];

    // get site name
    metadata.siteName = jsonld.siteName ||
                        values["og:site_name"];

    // get article published time
    metadata.publishedTime = jsonld.datePublished ||
      values["article:published_time"] || null;

    // in many sites the meta value is escaped with HTML entities,
    // so here we need to unescape it
    metadata.title = this._unescapeHtmlEntities(metadata.title);
    metadata.byline = this._unescapeHtmlEntities(metadata.byline);
    metadata.excerpt = this._unescapeHtmlEntities(metadata.excerpt);
    metadata.siteName = this._unescapeHtmlEntities(metadata.siteName);
    metadata.publishedTime = this._unescapeHtmlEntities(metadata.publishedTime);

    return metadata;
  },

  /**
   * Check if node is image, or if node contains exactly only one image
   * whether as a direct child or as its descendants.
   *
   * @param Element
  **/
  _isSingleImage: function(node) {
    if (node.tagName === "IMG") {
      return true;
    }

    if (node.children.length !== 1 || node.textContent.trim() !== "") {
      return false;
    }

    return this._isSingleImage(node.children[0]);
  },

  /**
   * Find all <noscript> that are located after <img> nodes, and which contain only one
   * <img> element. Replace the first image with the image from inside the <noscript> tag,
   * and remove the <noscript> tag. This improves the quality of the images we use on
   * some sites (e.g. Medium).
   *
   * @param Element
  **/
  _unwrapNoscriptImages: function(doc) {
    // Find img without source or attributes that might contains image, and remove it.
    // This is done to prevent a placeholder img is replaced by img from noscript in next step.
    var imgs = Array.from(doc.getElementsByTagName("img"));
    this._forEachNode(imgs, function(img) {
      for (var i = 0; i < img.attributes.length; i++) {
        var attr = img.attributes[i];
        switch (attr.name) {
          case "src":
          case "srcset":
          case "data-src":
          case "data-srcset":
            return;
        }

        if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
          return;
        }
      }

      img.parentNode.removeChild(img);
    });

    // Next find noscript and try to extract its image
    var noscripts = Array.from(doc.getElementsByTagName("noscript"));
    this._forEachNode(noscripts, function(noscript) {
      // Parse content of noscript and make sure it only contains image
      var tmp = doc.createElement("div");
      tmp.innerHTML = noscript.innerHTML;
      if (!this._isSingleImage(tmp)) {
        return;
      }

      // If noscript has previous sibling and it only contains image,
      // replace it with noscript content. However we also keep old
      // attributes that might contains image.
      var prevElement = noscript.previousElementSibling;
      if (prevElement && this._isSingleImage(prevElement)) {
        var prevImg = prevElement;
        if (prevImg.tagName !== "IMG") {
          prevImg = prevElement.getElementsByTagName("img")[0];
        }

        var newImg = tmp.getElementsByTagName("img")[0];
        for (var i = 0; i < prevImg.attributes.length; i++) {
          var attr = prevImg.attributes[i];
          if (attr.value === "") {
            continue;
          }

          if (attr.name === "src" || attr.name === "srcset" || /\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
            if (newImg.getAttribute(attr.name) === attr.value) {
              continue;
            }

            var attrName = attr.name;
            if (newImg.hasAttribute(attrName)) {
              attrName = "data-old-" + attrName;
            }

            newImg.setAttribute(attrName, attr.value);
          }
        }

        noscript.parentNode.replaceChild(tmp.firstElementChild, prevElement);
      }
    });
  },

  /**
   * Removes script tags from the document.
   *
   * @param Element
  **/
  _removeScripts: function(doc) {
    this._removeNodes(this._getAllNodesWithTag(doc, ["script", "noscript"]));
  },

  /**
   * Check if this node has only whitespace and a single element with given tag
   * Returns false if the DIV node contains non-empty text nodes
   * or if it contains no element with given tag or more than 1 element.
   *
   * @param Element
   * @param string tag of child element
  **/
  _hasSingleTagInsideElement: function(element, tag) {
    // There should be exactly 1 element child with given tag
    if (element.children.length != 1 || element.children[0].tagName !== tag) {
      return false;
    }

    // And there should be no text nodes with real content
    return !this._someNode(element.childNodes, function(node) {
      return node.nodeType === this.TEXT_NODE &&
             this.REGEXPS.hasContent.test(node.textContent);
    });
  },

  _isElementWithoutContent: function(node) {
    return node.nodeType === this.ELEMENT_NODE &&
      node.textContent.trim().length == 0 &&
      (node.children.length == 0 ||
       node.children.length == node.getElementsByTagName("br").length + node.getElementsByTagName("hr").length);
  },

  /**
   * Determine whether element has any children block level elements.
   *
   * @param Element
   */
  _hasChildBlockElement: function (element) {
    return this._someNode(element.childNodes, function(node) {
      return this.DIV_TO_P_ELEMS.has(node.tagName) ||
             this._hasChildBlockElement(node);
    });
  },

  /***
   * Determine if a node qualifies as phrasing content.
   * https://developer.mozilla.org/en-US/docs/Web/Guide/HTML/Content_categories#Phrasing_content
  **/
  _isPhrasingContent: function(node) {
    return node.nodeType === this.TEXT_NODE || this.PHRASING_ELEMS.indexOf(node.tagName) !== -1 ||
      ((node.tagName === "A" || node.tagName === "DEL" || node.tagName === "INS") &&
        this._everyNode(node.childNodes, this._isPhrasingContent));
  },

  _isWhitespace: function(node) {
    return (node.nodeType === this.TEXT_NODE && node.textContent.trim().length === 0) ||
           (node.nodeType === this.ELEMENT_NODE && node.tagName === "BR");
  },

  /**
   * Get the inner text of a node - cross browser compatibly.
   * This also strips out any excess whitespace to be found.
   *
   * @param Element
   * @param Boolean normalizeSpaces (default: true)
   * @return string
  **/
  _getInnerText: function(e, normalizeSpaces) {
    normalizeSpaces = (typeof normalizeSpaces === "undefined") ? true : normalizeSpaces;
    var textContent = e.textContent.trim();

    if (normalizeSpaces) {
      return textContent.replace(this.REGEXPS.normalize, " ");
    }
    return textContent;
  },

  /**
   * Get the number of times a string s appears in the node e.
   *
   * @param Element
   * @param string - what to split on. Default is ","
   * @return number (integer)
  **/
  _getCharCount: function(e, s) {
    s = s || ",";
    return this._getInnerText(e).split(s).length - 1;
  },

  /**
   * Remove the style attribute on every e and under.
   * TODO: Test if getElementsByTagName(*) is faster.
   *
   * @param Element
   * @return void
  **/
  _cleanStyles: function(e) {
    if (!e || e.tagName.toLowerCase() === "svg")
      return;

    // Remove `style` and deprecated presentational attributes
    for (var i = 0; i < this.PRESENTATIONAL_ATTRIBUTES.length; i++) {
      e.removeAttribute(this.PRESENTATIONAL_ATTRIBUTES[i]);
    }

    if (this.DEPRECATED_SIZE_ATTRIBUTE_ELEMS.indexOf(e.tagName) !== -1) {
      e.removeAttribute("width");
      e.removeAttribute("height");
    }

    var cur = e.firstElementChild;
    while (cur !== null) {
      this._cleanStyles(cur);
      cur = cur.nextElementSibling;
    }
  },

  /**
   * Get the density of links as a percentage of the content
   * This is the amount of text that is inside a link divided by the total text in the node.
   *
   * @param Element
   * @return number (float)
  **/
  _getLinkDensity: function(element) {
    var textLength = this._getInnerText(element).length;
    if (textLength === 0)
      return 0;

    var linkLength = 0;

    // XXX implement _reduceNodeList?
    this._forEachNode(element.getElementsByTagName("a"), function(linkNode) {
      var href = linkNode.getAttribute("href");
      var coefficient = href && this.REGEXPS.hashUrl.test(href) ? 0.3 : 1;
      linkLength += this._getInnerText(linkNode).length * coefficient;
    });

    return linkLength / textLength;
  },

  /**
   * Get an elements class/id weight. Uses regular expressions to tell if this
   * element looks good or bad.
   *
   * @param Element
   * @return number (Integer)
  **/
  _getClassWeight: function(e) {
    if (!this._flagIsActive(this.FLAG_WEIGHT_CLASSES))
      return 0;

    var weight = 0;

    // Look for a special classname
    if (typeof(e.className) === "string" && e.className !== "") {
      if (this.REGEXPS.negative.test(e.className))
        weight -= 25;

      if (this.REGEXPS.positive.test(e.className))
        weight += 25;
    }

    // Look for a special ID
    if (typeof(e.id) === "string" && e.id !== "") {
      if (this.REGEXPS.negative.test(e.id))
        weight -= 25;

      if (this.REGEXPS.positive.test(e.id))
        weight += 25;
    }

    return weight;
  },

  /**
   * Clean a node of all elements of type "tag".
   * (Unless it's a youtube/vimeo video. People love movies.)
   *
   * @param Element
   * @param string tag to clean
   * @return void
   **/
  _clean: function(e, tag) {
    var isEmbed = ["object", "embed", "iframe"].indexOf(tag) !== -1;

    this._removeNodes(this._getAllNodesWithTag(e, [tag]), function(element) {
      // Allow youtube and vimeo videos through as people usually want to see those.
      if (isEmbed) {
        // First, check the elements attributes to see if any of them contain youtube or vimeo
        for (var i = 0; i < element.attributes.length; i++) {
          if (this._allowedVideoRegex.test(element.attributes[i].value)) {
            return false;
          }
        }

        // For embed with <object> tag, check inner HTML as well.
        if (element.tagName === "object" && this._allowedVideoRegex.test(element.innerHTML)) {
          return false;
        }
      }

      return true;
    });
  },

  /**
   * Check if a given node has one of its ancestor tag name matching the
   * provided one.
   * @param  HTMLElement node
   * @param  String      tagName
   * @param  Number      maxDepth
   * @param  Function    filterFn a filter to invoke to determine whether this node 'counts'
   * @return Boolean
   */
  _hasAncestorTag: function(node, tagName, maxDepth, filterFn) {
    maxDepth = maxDepth || 3;
    tagName = tagName.toUpperCase();
    var depth = 0;
    while (node.parentNode) {
      if (maxDepth > 0 && depth > maxDepth)
        return false;
      if (node.parentNode.tagName === tagName && (!filterFn || filterFn(node.parentNode)))
        return true;
      node = node.parentNode;
      depth++;
    }
    return false;
  },

  /**
   * Return an object indicating how many rows and columns this table has.
   */
  _getRowAndColumnCount: function(table) {
    var rows = 0;
    var columns = 0;
    var trs = table.getElementsByTagName("tr");
    for (var i = 0; i < trs.length; i++) {
      var rowspan = trs[i].getAttribute("rowspan") || 0;
      if (rowspan) {
        rowspan = parseInt(rowspan, 10);
      }
      rows += (rowspan || 1);

      // Now look for column-related info
      var columnsInThisRow = 0;
      var cells = trs[i].getElementsByTagName("td");
      for (var j = 0; j < cells.length; j++) {
        var colspan = cells[j].getAttribute("colspan") || 0;
        if (colspan) {
          colspan = parseInt(colspan, 10);
        }
        columnsInThisRow += (colspan || 1);
      }
      columns = Math.max(columns, columnsInThisRow);
    }
    return {rows: rows, columns: columns};
  },

  /**
   * Look for 'data' (as opposed to 'layout') tables, for which we use
   * similar checks as
   * https://searchfox.org/mozilla-central/rev/f82d5c549f046cb64ce5602bfd894b7ae807c8f8/accessible/generic/TableAccessible.cpp#19
   */
  _markDataTables: function(root) {
    var tables = root.getElementsByTagName("table");
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var role = table.getAttribute("role");
      if (role == "presentation") {
        table._readabilityDataTable = false;
        continue;
      }
      var datatable = table.getAttribute("datatable");
      if (datatable == "0") {
        table._readabilityDataTable = false;
        continue;
      }
      var summary = table.getAttribute("summary");
      if (summary) {
        table._readabilityDataTable = true;
        continue;
      }

      var caption = table.getElementsByTagName("caption")[0];
      if (caption && caption.childNodes.length > 0) {
        table._readabilityDataTable = true;
        continue;
      }

      // If the table has a descendant with any of these tags, consider a data table:
      var dataTableDescendants = ["col", "colgroup", "tfoot", "thead", "th"];
      var descendantExists = function(tag) {
        return !!table.getElementsByTagName(tag)[0];
      };
      if (dataTableDescendants.some(descendantExists)) {
        this.log("Data table because found data-y descendant");
        table._readabilityDataTable = true;
        continue;
      }

      // Nested tables indicate a layout table:
      if (table.getElementsByTagName("table")[0]) {
        table._readabilityDataTable = false;
        continue;
      }

      var sizeInfo = this._getRowAndColumnCount(table);
      if (sizeInfo.rows >= 10 || sizeInfo.columns > 4) {
        table._readabilityDataTable = true;
        continue;
      }
      // Now just go by size entirely:
      table._readabilityDataTable = sizeInfo.rows * sizeInfo.columns > 10;
    }
  },

  /* convert images and figures that have properties like data-src into images that can be loaded without JS */
  _fixLazyImages: function (root) {
    this._forEachNode(this._getAllNodesWithTag(root, ["img", "picture", "figure"]), function (elem) {
      // In some sites (e.g. Kotaku), they put 1px square image as base64 data uri in the src attribute.
      // So, here we check if the data uri is too short, just might as well remove it.
      if (elem.src && this.REGEXPS.b64DataUrl.test(elem.src)) {
        // Make sure it's not SVG, because SVG can have a meaningful image in under 133 bytes.
        var parts = this.REGEXPS.b64DataUrl.exec(elem.src);
        if (parts[1] === "image/svg+xml") {
          return;
        }

        // Make sure this element has other attributes which contains image.
        // If it doesn't, then this src is important and shouldn't be removed.
        var srcCouldBeRemoved = false;
        for (var i = 0; i < elem.attributes.length; i++) {
          var attr = elem.attributes[i];
          if (attr.name === "src") {
            continue;
          }

          if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
            srcCouldBeRemoved = true;
            break;
          }
        }

        // Here we assume if image is less than 100 bytes (or 133B after encoded to base64)
        // it will be too small, therefore it might be placeholder image.
        if (srcCouldBeRemoved) {
          var b64starts = elem.src.search(/base64\s*/i) + 7;
          var b64length = elem.src.length - b64starts;
          if (b64length < 133) {
            elem.removeAttribute("src");
          }
        }
      }

      // also check for "null" to work around https://github.com/jsdom/jsdom/issues/2580
      if ((elem.src || (elem.srcset && elem.srcset != "null")) && elem.className.toLowerCase().indexOf("lazy") === -1) {
        return;
      }

      for (var j = 0; j < elem.attributes.length; j++) {
        attr = elem.attributes[j];
        if (attr.name === "src" || attr.name === "srcset" || attr.name === "alt") {
          continue;
        }
        var copyTo = null;
        if (/\.(jpg|jpeg|png|webp)\s+\d/.test(attr.value)) {
          copyTo = "srcset";
        } else if (/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/.test(attr.value)) {
          copyTo = "src";
        }
        if (copyTo) {
          //if this is an img or picture, set the attribute directly
          if (elem.tagName === "IMG" || elem.tagName === "PICTURE") {
            elem.setAttribute(copyTo, attr.value);
          } else if (elem.tagName === "FIGURE" && !this._getAllNodesWithTag(elem, ["img", "picture"]).length) {
            //if the item is a <figure> that does not contain an image or picture, create one and place it inside the figure
            //see the nytimes-3 testcase for an example
            var img = this._doc.createElement("img");
            img.setAttribute(copyTo, attr.value);
            elem.appendChild(img);
          }
        }
      }
    });
  },

  _getTextDensity: function(e, tags) {
    var textLength = this._getInnerText(e, true).length;
    if (textLength === 0) {
      return 0;
    }
    var childrenLength = 0;
    var children = this._getAllNodesWithTag(e, tags);
    this._forEachNode(children, (child) => childrenLength += this._getInnerText(child, true).length);
    return childrenLength / textLength;
  },

  /**
   * Clean an element of all tags of type "tag" if they look fishy.
   * "Fishy" is an algorithm based on content length, classnames, link density, number of images & embeds, etc.
   *
   * @return void
   **/
  _cleanConditionally: function(e, tag) {
    if (!this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY))
      return;

    // Gather counts for other typical elements embedded within.
    // Traverse backwards so we can remove nodes at the same time
    // without effecting the traversal.
    //
    // TODO: Consider taking into account original contentScore here.
    this._removeNodes(this._getAllNodesWithTag(e, [tag]), function(node) {
      // First check if this node IS data table, in which case don't remove it.
      var isDataTable = function(t) {
        return t._readabilityDataTable;
      };

      var isList = tag === "ul" || tag === "ol";
      if (!isList) {
        var listLength = 0;
        var listNodes = this._getAllNodesWithTag(node, ["ul", "ol"]);
        this._forEachNode(listNodes, (list) => listLength += this._getInnerText(list).length);
        isList = listLength / this._getInnerText(node).length > 0.9;
      }

      if (tag === "table" && isDataTable(node)) {
        return false;
      }

      // Next check if we're inside a data table, in which case don't remove it as well.
      if (this._hasAncestorTag(node, "table", -1, isDataTable)) {
        return false;
      }

      if (this._hasAncestorTag(node, "code")) {
        return false;
      }

      var weight = this._getClassWeight(node);

      this.log("Cleaning Conditionally", node);

      var contentScore = 0;

      if (weight + contentScore < 0) {
        return true;
      }

      if (this._getCharCount(node, ",") < 10) {
        // If there are not very many commas, and the number of
        // non-paragraph elements is more than paragraphs or other
        // ominous signs, remove the element.
        var p = node.getElementsByTagName("p").length;
        var img = node.getElementsByTagName("img").length;
        var li = node.getElementsByTagName("li").length - 100;
        var input = node.getElementsByTagName("input").length;
        var headingDensity = this._getTextDensity(node, ["h1", "h2", "h3", "h4", "h5", "h6"]);

        var embedCount = 0;
        var embeds = this._getAllNodesWithTag(node, ["object", "embed", "iframe"]);

        for (var i = 0; i < embeds.length; i++) {
          // If this embed has attribute that matches video regex, don't delete it.
          for (var j = 0; j < embeds[i].attributes.length; j++) {
            if (this._allowedVideoRegex.test(embeds[i].attributes[j].value)) {
              return false;
            }
          }

          // For embed with <object> tag, check inner HTML as well.
          if (embeds[i].tagName === "object" && this._allowedVideoRegex.test(embeds[i].innerHTML)) {
            return false;
          }

          embedCount++;
        }

        var linkDensity = this._getLinkDensity(node);
        var contentLength = this._getInnerText(node).length;

        var haveToRemove =
          (img > 1 && p / img < 0.5 && !this._hasAncestorTag(node, "figure")) ||
          (!isList && li > p) ||
          (input > Math.floor(p/3)) ||
          (!isList && headingDensity < 0.9 && contentLength < 25 && (img === 0 || img > 2) && !this._hasAncestorTag(node, "figure")) ||
          (!isList && weight < 25 && linkDensity > 0.2) ||
          (weight >= 25 && linkDensity > 0.5) ||
          ((embedCount === 1 && contentLength < 75) || embedCount > 1);
        // Allow simple lists of images to remain in pages
        if (isList && haveToRemove) {
          for (var x = 0; x < node.children.length; x++) {
            let child = node.children[x];
            // Don't filter in lists with li's that contain more than one child
            if (child.children.length > 1) {
              return haveToRemove;
            }
          }
          let li_count = node.getElementsByTagName("li").length;
          // Only allow the list to remain if every li contains an image
          if (img == li_count) {
            return false;
          }
        }
        return haveToRemove;
      }
      return false;
    });
  },

  /**
   * Clean out elements that match the specified conditions
   *
   * @param Element
   * @param Function determines whether a node should be removed
   * @return void
   **/
  _cleanMatchedNodes: function(e, filter) {
    var endOfSearchMarkerNode = this._getNextNode(e, true);
    var next = this._getNextNode(e);
    while (next && next != endOfSearchMarkerNode) {
      if (filter.call(this, next, next.className + " " + next.id)) {
        next = this._removeAndGetNext(next);
      } else {
        next = this._getNextNode(next);
      }
    }
  },

  /**
   * Clean out spurious headers from an Element.
   *
   * @param Element
   * @return void
  **/
  _cleanHeaders: function(e) {
    let headingNodes = this._getAllNodesWithTag(e, ["h1", "h2"]);
    this._removeNodes(headingNodes, function(node) {
      let shouldRemove = this._getClassWeight(node) < 0;
      if (shouldRemove) {
        this.log("Removing header with low class weight:", node);
      }
      return shouldRemove;
    });
  },

  /**
   * Check if this node is an H1 or H2 element whose content is mostly
   * the same as the article title.
   *
   * @param Element  the node to check.
   * @return boolean indicating whether this is a title-like header.
   */
  _headerDuplicatesTitle: function(node) {
    if (node.tagName != "H1" && node.tagName != "H2") {
      return false;
    }
    var heading = this._getInnerText(node, false);
    this.log("Evaluating similarity of header:", heading, this._articleTitle);
    return this._textSimilarity(this._articleTitle, heading) > 0.75;
  },

  _flagIsActive: function(flag) {
    return (this._flags & flag) > 0;
  },

  _removeFlag: function(flag) {
    this._flags = this._flags & ~flag;
  },

  _isProbablyVisible: function(node) {
    // Have to null-check node.style and node.className.indexOf to deal with SVG and MathML nodes.
    return (!node.style || node.style.display != "none")
      && (!node.style || node.style.visibility != "hidden")
      && !node.hasAttribute("hidden")
      //check for "fallback-image" so that wikimedia math images are displayed
      && (!node.hasAttribute("aria-hidden") || node.getAttribute("aria-hidden") != "true" || (node.className && node.className.indexOf && node.className.indexOf("fallback-image") !== -1));
  },

  /**
   * Runs readability.
   *
   * Workflow:
   *  1. Prep the document by removing script tags, css, etc.
   *  2. Build readability's DOM tree.
   *  3. Grab the article content from the current dom tree.
   *  4. Replace the current DOM tree with the new one.
   *  5. Read peacefully.
   *
   * @return void
   **/
  parse: function () {
    // Avoid parsing too large documents, as per configuration option
    if (this._maxElemsToParse > 0) {
      var numTags = this._doc.getElementsByTagName("*").length;
      if (numTags > this._maxElemsToParse) {
        throw new Error("Aborting parsing document; " + numTags + " elements found");
      }
    }

    // Unwrap image from noscript
    this._unwrapNoscriptImages(this._doc);

    // Extract JSON-LD metadata before removing scripts
    var jsonLd = this._disableJSONLD ? {} : this._getJSONLD(this._doc);

    // Remove script tags from the document.
    this._removeScripts(this._doc);

    this._prepDocument();

    var metadata = this._getArticleMetadata(jsonLd);
    this._articleTitle = metadata.title;

    var articleContent = this._grabArticle();
    if (!articleContent)
      return null;

    this.log("Grabbed: " + articleContent.innerHTML);

    this._postProcessContent(articleContent);

    // If we haven't found an excerpt in the article's metadata, use the article's
    // first paragraph as the excerpt. This is used for displaying a preview of
    // the article's content.
    if (!metadata.excerpt) {
      var paragraphs = articleContent.getElementsByTagName("p");
      if (paragraphs.length > 0) {
        metadata.excerpt = paragraphs[0].textContent.trim();
      }
    }

    var textContent = articleContent.textContent;
    return {
      title: this._articleTitle,
      byline: metadata.byline || this._articleByline,
      dir: this._articleDir,
      lang: this._articleLang,
      content: this._serializer(articleContent),
      textContent: textContent,
      length: textContent.length,
      excerpt: metadata.excerpt,
      siteName: metadata.siteName || this._articleSiteName,
      publishedTime: metadata.publishedTime
    };
  }
};

if (typeof module === "object") {
  /* global module */
  module.exports = Readability;
}

/* ===== Readability end ===== */

/* ============================================================
 * 养基宝 Lite
 *  - 数据源：天天基金 / 腾讯财经（全部公开接口）
 *  - 存储：localStorage
 *  - OCR：本地 ML Kit，图片不出设备
 * ============================================================ */

const S = {
  tab: 'hold',
  group: '全部',
  hideAmount: false,
  holdings: [],   // {code,name,shares,costNav,group}
  watch: [],      // {code,name}
  nav: {},        // code -> {date, nav, pct}
  gz: {},         // code -> {gsz, pct, time}
  full: {},       // code -> {trend, divs, type, lagDays} 全量历史，用于算分红
  holdCache: {},  // code -> {data:{list,report}, at} 季报持仓，一天缓存
  reportOf: {},   // code -> 最新已知报告期，用于发现新公告
  replay: {},     // code -> {score:{beta,r2}, at} 持仓回演结果，一天缓存
  perfCurve: null,// 账户历史收益率曲线
  perfDays: 60,   // 曲线区间
  chartRange: 60, // 净值走势图区间（交易日）
  klineScale: 5,  // K 线周期（分钟）
  perfBusy: false,
  _lastView: null,  // 上一次渲染的页面，用于判断要不要播进场动画
  indices: [],
  gidx: {},               // 全球指数 {code: {name,price,change,pct}}
  heat: null,             // map.findfin 全市场热力图 {summary, boards}
  heatStale: false,       // 当前 heat 是否来自过期缓存
  heatAge: null,
  heatErr: false,         // 上一次拉取是否失败（决定占位是骨架屏还是「重试」）
  heatLoading: false,     // 正在拉取中，防止 20 秒定时器叠加重复请求
  valuation: null,        // 板块估值 {name: {pe, mktCap}}（东财，可能不可用）
  idxVal: null,           // 指数估值（蛋卷）：{byCode, byName, date}
  idxValAt: null,
  heatAt: null,
  sectors: null,          // 板块资金流
  sectorKind: 'industry', // industry | concept
  sectorSort: 'inflow',   // inflow | pct | outflow | amount
  moodTab: 'concept',     // concept | industry | mom
  hot: null,              // {concept: [...], industry: [...]}
  hotAt: null,
  hotLoading: false,
  hotSort: 'heat',        // heat | pct | chg
  moodSort: 'score',      // score | heat | change
  holdSort: 'manual',     // manual | value | pnl | pct | today
  mktSeg: 'index',        // 默认大盘：打开行情页先看指数怎么走
  mom: null,              // 宝妈原始数据
  mood: null,             // 合成情绪榜
  limit: null,            // 涨停/跌停池
  commod: null,           // 商品行情
  news: null,             // 资讯
  newsLoading: false,
  newsErr: null,
  article: null,          // 正在阅读的正文
  articleFrom: 'news',    // 正文来源
  sectorDetail: null,     // 板块详情
  sectorFrom: 'market',   // 板块详情来源
  detail: null,
  detailFrom: 'hold',     // 详情页来源，用于返回
  predict: {},            // code -> 盘中预估结果
  predictOn: true,        // 是否在持仓页显示预估
  predBusy: false,
  cb: {}, cbSeq: 0,
};

/* ---------------- 原生桥 ---------------- */
window.__onNative = function (cbId, ok, payload) {
  const f = S.cb[cbId];
  if (!f) return;
  delete S.cb[cbId];
  ok ? f(payload) : f(null, payload);
};

function nativeAsync(fn) {
  return new Promise((res, rej) => {
    const id = 'cb' + (++S.cbSeq);
    S.cb[id] = (data, err) => err ? rej(new Error(err)) : res(data);
    try { fn(id); } catch (e) { delete S.cb[id]; rej(e); }
  });
}

/* ---------------- 对时 ---------------- */

/** 对时结果写日志。不走 diag 的关键词过滤，保证这条一定能落到文件。 */
function logTimeSync(ok, off) {
  const msg = ok
    ? ('时间已同步 · 本机偏移 ' + off + 'ms' + (off ? '（已补偿）' : ''))
    : '时间同步失败 · 接口不可达，使用本机时间';
  diag.info(msg);
  try {
    if (window.Native && Native.writeLogText) {
      Native.writeLogText(hhmmss() + ' T ' + msg);
    }
  } catch (e) { /* ignore */ }
}

/**
 * 启动时的对时。
 *
 * 原来是同步调 Native.forceSyncTime()：原生那边为了等结果做了
 * t.join(6000)，于是 WebView 的 JS 线程被硬冻住最多 **6 秒**——
 * 冷启动"点开半天没反应"就是它。更糟的是 doSync 正常要 6 秒以上，
 * join 先超时返回，于是永远报"同步失败"，时间偏移还停在旧值 0，
 * 交易时段判断、当日盈亏跟着一起错。
 *
 * 现在优先走异步接口，完全没有阻塞；只有拿不到异步接口时才退回
 * 同步调用，并且推到首帧之后再调，至少让用户先看见界面。
 */
function syncTimeAtBoot() {
  if (!window.Native) { diag.info('时间同步不可用 · 浏览器预览'); return; }

  const done = ok => {
    const off = (window.Native.timeOffset && Native.timeOffset()) || 0;
    logTimeSync(ok, off);
  };

  if (Native.syncTimeAsync) {
    nativeAsync(id => Native.syncTimeAsync(id))
      .then(() => done(true))
      .catch(() => done(false));
    return;
  }

  if (Native.forceSyncTime) {
    // 退路：别在首帧前调用，否则用户看到的就是一段白屏
    setTimeout(() => {
      try { done(Native.forceSyncTime()); } catch (e) { logTimeSync(false, 0); }
    }, 1500);
    return;
  }

  diag.info('时间同步不可用 · 缺少原生方法');
}

/* ---------------- 网络：单次请求 ---------------- */
/**
 * 单次请求。
 *
 * 这里再套一层超时：日志里出现过 31 秒、47 秒的请求，
 * 那是连接卡住而不是真的在传数据。超时后立刻放弃，
 * 把连接和线程让给别的请求——一个卡死的请求会把
 * OkHttp 的连接池占住，后面的全得排队。
 */
const HTTP_TIMEOUT = 12000;

function httpOnce(url, gbk) {
  const p = (window.Native && Native.httpGet)
    ? nativeAsync(id => Native.httpGet(url, !!gbk, id))
    : fetch(url).then(r => r.text());

  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), HTTP_TIMEOUT)),
  ]);
}

/* 连续失败计数：某源连续失败时暂时降级，避免每轮都卡在超时上 */
const netHealth = {};
const NET_COOL = 30 * 1000;   // 冷却 30 秒

/**
 * 带重试的 GET。
 * 各公开接口偶发超时/断连很常见（尤其中午与收盘时段），
 * 单次失败不代表源不可用，这里做指数退避重试。
 */

/** 带追踪的 GET：包一层，记录结果与耗时 */
/**
 * 把能走 HTTPS 的 http:// 请求升级成 https://。
 *
 * Android 的 network security config 默认禁止明文流量，日志里那条
 *   ERR:CLEARTEXT communication to finance.eastmoney.com not permitted
 * 就是这么来的 —— 东方财富的资讯接口返回的 url 字段很多都是
 * http:// 开头，直接拿去抓正文必然失败，用户点进去只能看到
 * 「正文提取失败」。
 *
 * 唯一的例外是 212.129.244.148（宝妈指数），它没有 HTTPS 服务，
 * 已经在 network_security_config.xml 里单独放行，必须原样保留。
 */
const CLEARTEXT_HOST_OK = /^http:\/\/212\.129\.244\.148([:\/]|$)/;
function upgradeToHttps(url) {
  const u = String(url || '');
  if (!/^http:\/\//i.test(u)) return u;
  if (CLEARTEXT_HOST_OK.test(u)) return u;
  return u.replace(/^http:\/\//i, 'https://');
}

async function httpGet(url, gbk, opt) {
  const t0 = Date.now();
  url = upgradeToHttps(url);
  let nm = url;
  try {
    if (typeof netTrace !== "undefined") nm = netTrace.short(url);
  } catch (e) { /* ignore */ }
  try {
    const v = await httpGetRaw(url, gbk, opt);
    const ms = Date.now() - t0;
    try {
      netTrace.push({ t: nowHHMM(), name: nm, ms, ok: true, len: String(v || "").length });
      // 成功不写日志，只有异常慢的才提醒一句
      if (ms > 6000) diag.warn("慢请求 " + nm, ms + "ms");
    } catch (e) { /* ignore */ }
    return v;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = (e && e.message) || String(e);
    try {
      netTrace.push({ t: nowHHMM(), name: nm, ms, ok: false, err: msg });
      diag.error("请求失败 " + nm, msg + " · " + ms + "ms");
    } catch (e2) { /* ignore */ }
    throw e;
  }
}

async function httpGetRaw(url, gbk, opt) {
  const o = opt || {};
  const tries = o.tries || 3;

  /* 每个请求都记一笔：谁、多久、成没成。失败时把原因带上，
     这是排查「数据出不来」最快的一手材料 */
  const _t0 = Date.now();
  const _nm = (typeof netTrace !== "undefined") ? netTrace.short(url) : url;
  const host = (url.match(/^https?:\/\/([^\/]+)/) || [])[1] || url;

  /*
   * 冷却期检查。
   *
   * 之前这里一进入冷却就直接抛错，而抛出的错误又会被上层
   * 当成「又一次失败」，导致冷却永不解封——日志里那串
   * 「源暂时不可用 · 5ms」全是这么来的，实际根本没发请求。
   *
   * 现在：
   *   1. 用独立的 COOLING 标记，不参与失败计数
   *   2. 阈值从 3 次放宽到 5 次（并发请求下 3 次太容易触发）
   *   3. 冷却时间从 90 秒缩到 30 秒
   */
  const h = netHealth[host];
  if (h && h.fail >= 5 && Date.now() - h.at < NET_COOL) {
    const err = new Error('冷却中');
    err.cooling = true;
    throw err;
  }

  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const t = await httpOnce(url, gbk);
      if (t == null) throw new Error('空响应');
      const s = String(t);
      // 服务端明确拒绝（HTTP 4xx/5xx）不重试，重试也不会变
      if (/^ERR:HTTP (4\d\d|5\d\d)/.test(s)) {
        const e2 = new Error('HTTP 拒绝');
        e2.httpReject = true;
        throw e2;
      }
      // 空 body / HTML 错误页 / 限流提示都视为失败
      if (!s.trim()) throw new Error('空响应');
      if (s.length < 40 && /error|forbidden|too many|denied|403|429/i.test(s)) {
        throw new Error('被限流');
      }
      netHealth[host] = { fail: 0, at: Date.now() };
      return s;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        await new Promise(r => setTimeout(r, 260 * (i + 1) + Math.random() * 220));
      }
    }
  }
  /*
   * 只有「网络层失败」才计入冷却。
   *
   * HTTP 501 是服务端明确表示「这个接口/参数我不支持」，
   * 重试一万次也不会变，但它也不是网络不通。
   * 把 501 算成失败会让整个域名进冷却，
   * 连带把同域名下正常的接口一起封掉——日志里那串
   * 「冷却中 · 0ms」就是这么来的。
   */
  const msg = String((lastErr && lastErr.message) || '');
  const isHttpReject = /HTTP 4\d\d|HTTP 5\d\d/.test(msg);
  if (!isHttpReject) {
    const prev = netHealth[host] || { fail: 0 };
    netHealth[host] = { fail: prev.fail + 1, at: Date.now() };
  }
  throw lastErr || new Error('请求失败');
}

/** 依次尝试多个候选 URL，任一成功即返回。 */
async function httpFirst(urls, gbk, opt) {
  let lastErr = null;
  for (const u of urls) {
    if (!u) continue;
    try {
      return await httpGet(u, gbk, opt);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('全部源不可用');
}

/* ---------------- 全球指数清单 ----------------
 * 全部代码 2026-10-20 逐个实测可用（新浪 hq.sinajs.cn）。
 *
 *   sh/sz   A 股指数：名称,今开,昨收,当前,...,日期[30],时间[31]
 *   hk*     港股：腾讯格式（字段 1=名称 3=现价 31=涨跌 32=涨跌幅）
 *   gb_*    美股：名称[0] 现价[1] 涨跌幅[2] 时间[3] 涨跌[4]
 *   b_*     全球：名称[0] 现价[1] 涨跌[2] 涨跌幅[3] 日期[6] 时间[7]
 */
const GLOBAL_GROUPS = [
  {
    title: 'A 股 · 宽基',
    items: [
      { code: 'sh000001', name: '上证指数' },
      { code: 'sz399001', name: '深证成指' },
      { code: 'sz399006', name: '创业板指' },
      { code: 'sh000688', name: '科创50' },
      { code: 'sh000300', name: '沪深300' },
      { code: 'sh000905', name: '中证500' },
      { code: 'sh000852', name: '中证1000' },
      { code: 'sh000016', name: '上证50' },
      { code: 'sh000010', name: '上证180' },
      { code: 'sz399005', name: '中小100' },
      { code: 'sz399673', name: '创业板50' },
      // 覆盖沪深全市场的那只「A 股全指」，底部指数条要用
      { code: 'sz399317', name: '国证A指' },
    ],
  },
  {
    title: '港股',
    items: [
      { code: 'hkHSI', name: '恒生指数' },
      { code: 'hkHSCEI', name: '国企指数' },
      { code: 'hkHSTECH', name: '恒生科技' },
    ],
  },
  {
    title: '美股',
    items: [
      { code: 'gb_dji', name: '道琼斯' },
      { code: 'gb_ixic', name: '纳斯达克' },
      { code: 'gb_inx', name: '标普500' },
      { code: 'gb_ndx', name: '纳斯达克100' },
      { code: 'gb_sox', name: '费城半导体' },
    ],
  },
  {
    title: '欧洲',
    items: [
      { code: 'b_FTSE', name: '英国富时100' },
      { code: 'b_DAX', name: '德国DAX' },
      { code: 'b_CAC', name: '法国CAC40' },
      { code: 'b_SX5E', name: '欧洲斯托克50' },
      { code: 'b_FTSEMIB', name: '意大利MIB' },
      { code: 'b_IBEX', name: '西班牙IBEX' },
      { code: 'b_AEX', name: '荷兰AEX' },
      { code: 'b_OBX', name: '挪威OBX' },
      { code: 'b_OMX', name: '瑞典OMX30' },
    ],
  },
  {
    title: '亚太',
    items: [
      { code: 'b_NKY', name: '日经225' },
      { code: 'b_TOPIX', name: '日本东证' },
      { code: 'b_KOSPI', name: '韩国KOSPI' },
      { code: 'b_TWSE', name: '台湾加权' },
      { code: 'b_AS51', name: '澳洲200' },
      { code: 'b_SENSEX', name: '印度孟买30' },
      { code: 'b_STI', name: '新加坡STI' },
      { code: 'b_SET', name: '泰国SET' },
    ],
  },
];

/* 全部代码（一次性拉取） */
const ALL_GLOBAL_CODES = GLOBAL_GROUPS.flatMap(g => g.items.map(i => i.code));

/**
 * 底部指数条的指数清单，**数组顺序就是展示顺序**。
 *
 * 排序逻辑：先 A 股宽基，再美股。
 *   A 股内部按「代表性」而不是按代码：上证指数是全市场第一风向标，
 *   沪深300 是机构业绩基准，然后才是深证、创业板、科创50 这些风格指数；
 *   国证A指放最后收尾，它覆盖沪深全市场，属于「总览」性质。
 *   美股按关注度：纳斯达克（科技）→ 标普500（宽基）→ 道琼斯（传统蓝筹）。
 *
 * 这些代码必须都能被 allGlobal() 拉到，见 ALL_GLOBAL_CODES。
 */
const IDXBAR_ORDER = [
  'sh000001',   // 上证指数
  'sh000300',   // 沪深300
  'sz399001',   // 深证成指
  'sz399006',   // 创业板指
  'sh000688',   // 科创50
  'sz399317',   // 国证A指（A 股全指）
  'gb_ixic',    // 纳斯达克
  'gb_inx',     // 标普500
  'gb_dji',     // 道琼斯
];

/** 从全量指数里按上面的顺序挑出指数条要显示的那几个 */
function pickIdxbar(gidx) {
  return IDXBAR_ORDER.map(c => gidx[c]).filter(Boolean);
}

/* ---------------- API ---------------- */
const api = {
  async navHistory(code, size = 20) {
    const t = await httpGet(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${size}`);
    const j = JSON.parse(t);
    return (j.Data && j.Data.LSJZList || []).map(o => ({
      date: o.FSRQ,
      nav: parseFloat(o.DWJZ) || 0,
      pct: parseFloat(o.JZZZL),
    }));
  },

  async search(kw) {
    const t = await httpGet('https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + encodeURIComponent(kw));
    const j = JSON.parse(t);
    return (j.Datas || []).filter(o => o.CODE).map(o => ({ code: o.CODE, name: o.NAME }));
  },

  /** 基金完整档案 */
  async fundDetail(code) {
    const t = await httpGet(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`);
    const str = n => {
      const m = t.match(new RegExp('var\\s+' + n + '\\s*=\\s*"?([^";]*)'));
      return m ? m[1].trim() : '';
    };
    const json = n => {
      const m = t.match(new RegExp('var\\s+' + n + '\\s*=\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\});'));
      if (!m) return null;
      try { return JSON.parse(m[1]); } catch (e) { return null; }
    };

    const manager = (json('Data_currentFundManager') || [])[0] || null;
    const alloc = json('Data_assetAllocation');
    const trend = (json('Data_netWorthTrend') || []).slice(-120);

    let allocNow = null;
    if (alloc && alloc.series) {
      allocNow = alloc.series.map(s => ({
        name: s.name.replace('占净比', ''),
        value: (s.data && s.data.length) ? s.data[s.data.length - 1] : null,
      })).filter(x => x.value != null);
    }

    return {
      code, name: str('fS_name'),
      rate: parseFloat(str('fund_Rate')),
      minBuy: parseFloat(str('fund_minsg')),
      syl_1y: parseFloat(str('syl_1y')),
      syl_3y: parseFloat(str('syl_3y')),
      syl_6y: parseFloat(str('syl_6y')),
      syl_1n: parseFloat(str('syl_1n')),
      trend,
      manager: manager ? {
        name: manager.name, star: manager.star,
        workTime: manager.workTime, fundSize: manager.fundSize,
      } : null,
      alloc: allocNow,
    };
  },

  /**
   * 基金全量历史 + 分红事件 + 类型判定。
   *
   * 数据源是 pingzhongdata，一次请求就带回：
   *   Data_netWorthTrend  单位净值曲线（含当日涨跌幅）
   *   Data_ACWorthTrend   累计净值曲线
   *
   * 两个曲线之差就是分红：
   *   每份分红 = Δ累计净值 - Δ单位净值
   * 因为累计净值把分红加回去了，单位净值则被除息砸下去，
   * 两者差值恰好等于当天派发的金额。拆分同理（差分更大）。
   *
   * 这样不必抓分红公告表，也不会漏掉历史任何一次分红。
   */
  async fundFull(code) {
    const t = await httpGet(
      'https://fund.eastmoney.com/pingzhongdata/' + code + '.js?v=' + Date.now());

    const str = n => {
      const m = t.match(new RegExp('var\\s+' + n + '\\s*=\\s*"?([^";]*)'));
      return m ? m[1].trim() : '';
    };
    const arr = n => {
      const k = t.indexOf('var ' + n + ' = ');
      if (k < 0) return null;
      const e = t.indexOf(';', k);
      if (e < 0) return null;
      try { return JSON.parse(t.slice(k + ('var ' + n + ' = ').length, e)); }
      catch (err) { return null; }
    };

    const net = arr('Data_netWorthTrend') || [];
    const acw = arr('Data_ACWorthTrend') || [];
    const acMap = Object.create(null);
    for (const a of acw) acMap[a[0]] = a[1];

    // 合并成按日期升序的序列
    const trend = [];
    for (const o of net) {
      const ts = +o.x;
      const nav = +o.y;
      const acwv = acMap[ts];
      trend.push({
        ts,
        // 时间戳是北京时间当日零点，直接 toISOString 会因时区整体提前一天，
        // 和指数日线对不上，回归出来 r2 会低到没法用。
        date: new Date(ts + 8 * 3600e3).toISOString().slice(0, 10),
        nav,
        acw: acwv == null ? nav : +acwv,
        pct: isFinite(+o.equityReturn) ? +o.equityReturn : null,
      });
    }
    trend.sort((a, b) => a.ts - b.ts);

    // 分红 / 拆分事件
    const divs = [];
    for (let k = 1; k < trend.length; k++) {
      const du = trend[k].nav - trend[k - 1].nav;
      const da = trend[k].acw - trend[k - 1].acw;
      const per = +(da - du).toFixed(4);
      if (Math.abs(per) >= 0.0005) {
        divs.push({ date: trend[k].date, per, kind: per > 0 ? 'div' : 'split' });
      }
    }

    const name = str('fS_name');
    const last = trend.length ? trend[trend.length - 1] : null;

    return {
      code, name,
      trend,
      divs,
      latest: last,
      type: fundType(name, trend),
      lagDays: last ? dayGap(last.date) : null,
    };
  },

  /**
   * 指数实时行情（腾讯，一次可查多个）。
   * 返回 { code: { name, price, change, pct } }
   */
  async indexQuote(codes) {
    if (!codes || !codes.length) return {};
    const out = {};
    const t = await httpFirst(
      codes.map(cs => 'https://qt.gtimg.cn/q=' + cs.map(c => 's_' + c).join(',')),
      false, { tries: 3 });
    const text = typeof t === 'string' ? t : '';
    const re = /v_s_([A-Za-z0-9_.]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) {
      const f = m[2].split('~');
      if (f.length < 6) continue;
      out[m[1]] = {
        name: f[1],
        price: parseFloat(f[3]),
        change: parseFloat(f[4]),
        pct: parseFloat(f[5]),
      };
    }
    return out;
  },

  /**
   * 指数日线（腾讯前复权）。
   * 返回按日期升序的 [{date, close, pct}]，最后一根是当日实时行情。
   */
  async indexHistory(code, n = 90) {
    /* 同一指数在一轮刷新里会被多只基金各拉一次，缓存 60 秒足够 */
    const ck = 'k_' + code + '_' + n;
    const hit = cache.get(ck);
    if (hit && hit.val) return hit.val;

    /*
     * 双数据源。
     *
     * 腾讯 web.ifzq.gtimg.cn 在电脑上正常，但在手机移动网络下
     * 稳定返回 HTTP 501，指数基金的预测因此全部退化成重仓法。
     * 新浪的 K 线接口对移动网络友好，实测可用，所以把它放第一位。
     *
     * 两个源都失败才抛错，调用方会自己降级。
     */
    let out = null;
    try { out = await this._klineSina(code, n); } catch (e) { out = null; }
    if (!out || out.length < 5) {
      try { out = await this._klineTx(code, n); } catch (e) { out = null; }
    }
    if (!out || !out.length) throw new Error('K线不可用');

    cache.set(ck, out, 60 * 1000);
    return out;
  },

  /**
   * 分钟 / 日 K 线（带 OHLC）。
   *
   * 新浪这个接口返回的是标准 OHLC，所以能画真正的蜡烛图；
   * 之前的 indexHistory 只取收盘价，只能画折线。
   *
   * scale 单位是分钟：5 / 15 / 30 / 60，或者 240 表示日线。
   */
  async kline(code, scale, count) {
    const n = count || 60;
    const ck = 'kl_' + code + '_' + scale + '_' + n;
    const hit = cache.get(ck);
    if (hit && hit.val) return hit.val;

    const url = 'https://quotes.sina.cn/cn/api/json_v2.php/'
      + 'CN_MarketDataService.getKLineData?symbol=' + code
      + '&scale=' + scale + '&ma=no&datalen=' + n;

    const t = await klineGate.run(() => httpGet(url, false, { tries: 1 }));
    let arr;
    try { arr = JSON.parse(t); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];

    const out = arr.map(d => ({
      time: d.day,
      open: parseFloat(d.open),
      high: parseFloat(d.high),
      low: parseFloat(d.low),
      close: parseFloat(d.close),
      vol: parseFloat(d.volume) || 0,
    })).filter(x => isFinite(x.close));

    /* 分钟线变化快，缓存短一些；日线可以放久点 */
    cache.set(ck, out, scale >= 240 ? 10 * 60 * 1000 : 90 * 1000);
    return out;
  },

  /** 新浪 K 线：移动网络下最稳的一个 */
  async _klineSina(code, n) {
    const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/'
      + 'CN_MarketData.getKLineData?symbol=' + code
      + '&scale=240&ma=no&datalen=' + Math.min(n, 250);
    const t = await klineGate.run(() => httpGet(url, false, { tries: 1 }));
    let arr;
    try { arr = JSON.parse(t); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;

    const out = [];
    for (let k = 0; k < arr.length; k++) {
      const d = arr[k];
      const close = parseFloat(d.close);
      if (!isFinite(close)) continue;
      const prev = k ? parseFloat(arr[k - 1].close) : close;
      out.push({
        date: (d.day || '').slice(0, 10),
        close,
        pct: prev ? (close / prev - 1) * 100 : 0,
      });
    }
    return out;
  },

  /** 腾讯 K 线：桌面网络可用，作为备用 */
  async _klineTx(code, n) {
    const t = await klineGate.run(() => httpGet(
      'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='
      + code + ',day,,,' + n + ',qfq', false, { tries: 1 }));
    const j = JSON.parse(t);
    const k = ((j.data || {})[code]) || {};
    const day = k.day || k.qfqday || [];
    const out = [];
    for (let i = 0; i < day.length; i++) {
      const d = day[i];
      const close = parseFloat(d[2]);
      if (!isFinite(close)) continue;
      const prev = i ? parseFloat(day[i - 1][2]) : close;
      out.push({
        date: d[0],
        close,
        pct: prev ? (close / prev - 1) * 100 : 0,
      });
    }
    return out;
  },

  /**
   * 人民币汇率当日涨跌幅（%）。
   *
   * QDII 的净值以人民币计价：海外资产涨 x%、人民币贬 y%，
   * 持有人实际拿到的是 (1+x)(1+y)-1。忽略汇率会系统性高估或低估收益。
   *
   * 新浪外汇字段：时间,买价,卖价,昨收,量,今开,最高,最低,现价,名称,日期,涨跌幅%
   * 涨跌幅在第 10 位（0 起算），直接取用，不用自己算。
   */
  async fxChange(pair) {
    const t = await httpGet('https://hq.sinajs.cn/list=' + pair, false, { tries: 2 });
    const m = String(t).match(new RegExp('hq_str_' + pair + '="([^"]*)"'));
    if (!m) return null;
    const f = m[1].split(',');
    if (f.length < 11) return null;
    const pct = parseFloat(f[10]);
    return isFinite(pct) ? pct : null;
  },

  /**
   * 实时估值（盘中估算净值）。
   *
   * 原来是 <script> 注入 JSONP。那条路有三个问题：
   *   1. 绕开原生桥 —— 没有 Referer、没有 GBK 解码；
   *   2. 浏览器会把拿到的响应**当代码执行**；
   *   3. 没有任何内容校验。
   *
   * 而 fundgz 这个源现在已经下线了（无论怎么改请求头、Referer、UA，
   * 一律返回 200 + 3924 字节的 HTML「页面未找到」）。
   * 结果就是：每只持仓、每轮刷新，都在页面里执行一段 HTML，
   * 顶层 '<' 直接触发全局未捕获的 SyntaxError。
   * 日志被这些噪音刷满，真正的问题反而看不见。
   *
   * 改成走桥取文本 + 严格校验：拿不到就安静返回 null，
   * 调用方会自然退回 predict（指数回归 / 重仓股加权）那条路，
   * 那条路本来就更准，也更符合这个 App 的定位。
   * 等哪天源恢复了，这里不用改就能自动接上。
   */
  async gz(code) {
    try {
      const t = await httpGet(
        'https://fundgz.1234567.com.cn/js/' + code + '.js?rt=' + Date.now(),
        false, { tries: 1 });
      const m = String(t).match(/jsonpgz\(\s*(\{[\s\S]*?\})\s*\)/);
      if (!m) return null;              // 拿到的是错误页，静默跳过
      const j = JSON.parse(m[1]);
      return (j && j.fundcode) ? j : null;
    } catch (e) {
      return null;
    }
  },

  /** 重仓股当日涨跌 */
  stockQuotes(codes) {
    return new Promise(resolve => {
      const out = {};
      const varOf = c => {
        if (/^\d{6}$/.test(c)) {
          const p = /^[69]/.test(c) ? 'sh' : (/^[48]/.test(c) ? 'bj' : 'sz');
          return `v_s_${p}${c}`;
        }
        if (/^\d{5}$/.test(c)) return `v_s_hk${c}`;
        return null;
      };
      const arg = codes.map(c => {
        if (/^\d{6}$/.test(c)) {
          const p = /^[69]/.test(c) ? 'sh' : (/^[48]/.test(c) ? 'bj' : 'sz');
          return `s_${p}${c}`;
        }
        return `s_hk${c}`;
      }).join(',');

      const s = document.createElement('script');
      s.src = `https://qt.gtimg.cn/q=${arg}`;
      s.onload = () => {
        codes.forEach(c => {
          const vn = varOf(c);
          if (!vn) return;
          const v = window[vn];
          if (!v) return;
          const p = v.split('~');
          if (p.length > 5) out[c] = parseFloat(p[5]);
        });
        s.remove();
        resolve(out);
      };
      s.onerror = () => { s.remove(); resolve(out); };
      document.body.appendChild(s);
      setTimeout(() => { s.remove(); resolve(out); }, 6000);
    });
  },

  /* ---------------- map.findfin.app（开源 A 股热力图） ----------------
   * 提供全市场快照：
   *   /api/heatmap/overview  大盘涨跌、涨跌家数、成交额
   *   /api/heatmap/treemap   32 个板块 × 全部成分股的树形数据
   * 数据更新快（约 10 秒），一次拿到整个市场，比逐个接口拼装更稳。
   */
  FINDFIN: 'https://map.findfin.app',

  /** 全市场板块树（板块 + 成分股）。 */
  /**
   * 统一情绪榜。
   *
   * 原来的「宝妈指数」只有 16 个板块，其中一半服务端给的是占位值
   * （score 恒为 5、热度恒为 5），等于只有 8 个能看。
   * 板块数量太少，用户没法据此判断今天到底哪个方向在起势。
   *
   * 这里改成自己合成：把三个各有侧重的源拉到一起打分。
   *
   *   findfin 热力图   32 个行业，有真实涨跌幅和成分股涨跌家数
   *   同花顺热榜       40 个概念/行业，有平台真实热度 rate
   *   宝妈指数         8 个有效项，有独家的买卖情绪比
   *
   * 三者互补：涨跌告诉我们「已经涨了多少」，
   * 涨跌家数告诉我们「是普涨还是被权重拉起来的」，
   * 热度告诉我们「有多少人在看」，买卖比告诉我们「情绪偏多还是偏空」。
   *
   * 合成分数（0~100，50 为中性）：
   *   50 + 25·tanh(涨跌幅/2.5) + 15·(上涨占比×2-1) + 10·tanh((热度-50)/30)
   *
   * 用 tanh 是为了压住极端值：涨 9% 和涨 5% 的情绪差别不该是线性的，
   * 都算「很热」，但不至于让一个板块把整个榜拉爆。
   */
  async moodBoard() {
    const [heat, thsC, thsI, mom] = await Promise.all([
      this.heatTree().catch(() => null),
      this.thsHot('concept').catch(() => []),
      this.thsHot('industry').catch(() => []),
      this.momIndex().catch(() => []),
    ]);

    const out = [];
    const seen = Object.create(null);

    const push = rec => {
      const key = rec.name;
      if (!key) return;
      const old = seen[key];
      if (old) {
        // 同名板块：补上缺的维度，不重复占位
        if (old.heat == null && rec.heat != null) old.heat = rec.heat;
        if (old.buySell == null && rec.buySell != null) old.buySell = rec.buySell;
        if (old.pct == null && rec.pct != null) old.pct = rec.pct;
        if (old.upRatio == null && rec.upRatio != null) old.upRatio = rec.upRatio;
        old.sources[rec.source] = 1;
        return;
      }
      rec.sources = { [rec.source]: 1 };
      seen[key] = rec;
      out.push(rec);
    };

    // 1) 行业板块：有涨跌幅和成分股涨跌家数，覆盖面最广
    if (heat && heat.boards) {
      for (const b of heat.boards) {
        const total = (b.up || 0) + (b.down || 0);
        push({
          name: b.name,
          pct: b.pct,
          upRatio: total ? (b.up || 0) / total : null,
          heat: null,
          buySell: null,
          source: 'board',
        });
      }
    }

    // 2) 同花顺热榜：平台真实热度，带涨跌幅
    for (const arr of [thsC, thsI]) {
      for (const h of (arr || [])) {
        const rf = parseFloat(String(h.riseAndFall || '').replace('%', ''));
        push({
          name: h.name,
          pct: isFinite(rf) ? rf : null,
          upRatio: null,
          heat: isFinite(h.rate) ? h.rate : null,
          buySell: null,
          source: 'ths',
          hotTag: h.hotTag || '',
        });
      }
    }

    // 3) 宝妈指数：独家的买卖情绪比
    for (const m of (mom || [])) {
      if (!m.valid) continue;
      push({
        name: m.name,
        pct: null,
        upRatio: null,
        heat: isFinite(m.heat) ? m.heat : null,
        buySell: m.buySell || null,
        source: 'mom',
      });
    }

    // 打分
    for (const r of out) {
      let sc = 50;
      if (r.pct != null && isFinite(r.pct)) sc += 25 * Math.tanh(r.pct / 2.5);
      if (r.upRatio != null) sc += 15 * (r.upRatio * 2 - 1);
      if (r.heat != null) sc += 10 * Math.tanh((r.heat - 50) / 30);
      r.score = Math.max(1, Math.min(100, sc));

      // 档位
      if (r.score >= 72) { r.status = '过热'; r.color = '#ef4444'; }
      else if (r.score >= 58) { r.status = '升温'; r.color = '#f59e0b'; }
      else if (r.score >= 42) { r.status = '平稳'; r.color = '#22c55e'; }
      else if (r.score >= 28) { r.status = '降温'; r.color = '#38bdf8'; }
      else { r.status = '冰点'; r.color = '#64748b'; }
    }

    // 只保留有实际数据的，按情绪分排序
    return out.filter(r => r.pct != null || r.heat != null || r.buySell)
      .sort((a, b) => b.score - a.score);
  },

  /**
   * 涨停 / 跌停池。
   *
   * 这是判断市场情绪最直接的数据，比涨跌幅本身还有用：
   *   涨停多、跌停少  做多情绪强
   *   连板高度         资金愿不愿意接高位
   *   炸板率高         说明资金不坚决，冲高就卖
   *
   * 返回汇总 + 连板梯队，不返回全部个股（几十只够看，多了是噪音）。
   */
  async limitPool(date) {
    const d = date || todayStr().replace(/-/g, '');
    const base = 'https://push2ex.eastmoney.com/';
    const ut = 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt';

    const one = async (path, sort) => {
      const t = await httpGet(
        base + path + '?' + ut + '&Pageindex=0&pagesize=60&sort=' + sort + '&date=' + d,
        false, { tries: 2 });
      const j = JSON.parse(t);
      return (j && j.data) || null;
    };

    let up = null, down = null;
    try { up = await one('getTopicZTPool', 'fbt%3Aasc'); } catch (e) { up = null; }
    try { down = await one('getTopicDTPool', 'fund%3Aasc'); } catch (e) { down = null; }

    const upPool = (up && up.pool) || [];
    const downPool = (down && down.pool) || [];

    // 连板梯队：最大连板高度是第一眼要看的
    const ladder = Object.create(null);
    let maxLb = 0, broken = 0;
    for (const x of upPool) {
      const lb = x.lbc || 1;
      ladder[lb] = (ladder[lb] || 0) + 1;
      if (lb > maxLb) maxLb = lb;
      if ((x.zbc || 0) > 0) broken += 1;
    }

    return {
      date: d,
      upCount: (up && up.tc) || upPool.length,
      downCount: (down && down.tc) || downPool.length,
      maxStreak: maxLb,
      ladder,
      broken,
      up: upPool.slice(0, 20).map(x => ({
        code: x.c, name: x.n, pct: x.zdp,
        streak: x.lbc || 1, board: x.hybk || '',
        sealAmount: x.fund || 0, broken: x.zbc || 0,
      })),
      down: downPool.slice(0, 10).map(x => ({
        code: x.c, name: x.n, pct: x.zdp, board: x.hybk || '',
      })),
    };
  },

  /**
   * 商品行情：黄金、原油等。
   * 这类品种和 A 股相关性低，但能解释避险情绪，
   * 也是基金里黄金/资源类品种的定价参照。
   */
  async commodities() {
    const t = await httpFirst([
      'https://qt.gtimg.cn/q=hf_GC,hf_CL,hf_SI,hf_HG',
    ], false, { tries: 2 });
    const out = [];
    const re = /v_hf_([A-Z]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(String(t)))) {
      const f = m[2].split(',');
      if (f.length < 5) continue;
      const nameMap = { GC: 'COMEX黄金', CL: 'NYMEX原油', SI: 'COMEX白银', HG: 'COMEX铜' };
      out.push({
        code: m[1],
        name: nameMap[m[1]] || m[1],
        price: parseFloat(f[0]),
        pct: parseFloat(f[1]),
      });
    }
    return out;
  },

  /**
   * 板块成分股（东财）。
   *
   * findfin 只按申万一级行业分，概念板块（黄金、CPO、CRO）没有对应数据；
   * 这里用东财的板块行情接口按名字查，查不到就返回空，不抛错。
   *
   * 字段含义：
   *   f12 代码  f14 名称  f2 最新价  f3 涨跌幅  f20 总市值
   */
  async sectorStocks(name) {
    if (!name) return [];
    /*
     * 只从热力图里取成分股。
     *
     * 之前这里会去请求东财 push2 的板块成分股接口，但那个域名
     * 在当前网络下整片不可达，每次点板块都要白等 2 秒多再降级。
     * 热力图本身已经带了全部 A 股按行业的分组，覆盖 32 个行业，
     * 够用且零延迟。
     *
     * 概念板块（黄金、CPO 这类）热力图里没有，返回空，
     * 由调用方展示情绪分和相关消息。
     */
    const boards = (S.heat && S.heat.boards) || [];
    const bd = boards.find(b => b.name === name)
      || boards.find(b => b.name.indexOf(name) >= 0 || name.indexOf(b.name) >= 0);
    if (bd && bd.stocks && bd.stocks.length) {
      return bd.stocks.slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
    }
    return [];
  },

  async heatTree() {
    const t = await httpGet(this.FINDFIN + '/api/heatmap/treemap?market=all&period=day',
      false, { tries: 3 });
    const j = JSON.parse(t);
    const sum = j.summary || {};
    return {
      updatedAt: j.updatedAt,
      stockCount: j.stockCount,
      boardCount: j.boardCount,
      summary: {
        advance: sum.advanceCount || 0,
        flat: sum.flatCount || 0,
        decline: sum.declineCount || 0,
        turnover: sum.turnoverAmount || 0,
        turnoverPrev: sum.turnoverPreviousAmount || 0,
        indexPct: sum.indexChangePct,
      },
      boards: (j.nodes || []).map(b => {
        const kids = b.children || [];
        // 板块涨跌用成分股市值加权，比等权更贴近指数
        let wSum = 0, wPct = 0, up = 0, down = 0;
        for (const s of kids) {
          const w = s.value || 1;
          wSum += w;
          wPct += (s.changePct || 0) * w;
          if (s.changePct > 0) up++; else if (s.changePct < 0) down++;
        }
        return {
          code: b.code,
          name: b.name,
          value: b.value,
          stockCount: b.stockCount,
          pct: wSum ? wPct / wSum : 0,
          up, down,
          leader: kids.length
            ? kids.slice().sort((x, y) => (y.changePct || 0) - (x.changePct || 0))[0].name
            : '',
          stocks: kids,
        };
      }),
    };
  },

  /**
   * 板块资金流（东财公开接口）。
   * kind: 'industry' 行业板块 / 'concept' 概念板块
   * 返回 [{name, pct, inflow(元), up, down, leader}]
   */
  /**
   * 指数估值（蛋卷基金公开接口）。
   *
   * 返回 63 个主要指数的 PE / PB / 历史分位 / 估值档位。
   * 历史分位是关键：它回答「当前估值在历史上算贵还是便宜」，
   * 比单看 PE 数字有用得多。
   *
   *   pe          市盈率
   *   pePct       PE 历史分位 0~1，越低越便宜
   *   pb         市净率
   *   pbPct       PB 历史分位
   *   roe         净资产收益率
   *   yield       股息率
   *   eva         low / mid / high（低估 / 适中 / 高估）
   *   date        数据日期
   *
   * 该数据每日更新一次，适合长缓存。
   */
  async indexValuation() {
    const t = await httpGet('https://danjuanfunds.com/djapi/index_eva/dj',
      false, { tries: 3 });
    const j = JSON.parse(t);
    const items = ((j.data || {}).items) || [];
    const out = { byCode: {}, byName: {}, date: '' };
    for (const o of items) {
      const rec = {
        name: o.name,
        code: o.index_code,
        pe: parseFloat(o.pe) || null,
        pePct: isFinite(parseFloat(o.pe_percentile)) ? parseFloat(o.pe_percentile) : null,
        pb: parseFloat(o.pb) || null,
        pbPct: isFinite(parseFloat(o.pb_percentile)) ? parseFloat(o.pb_percentile) : null,
        roe: parseFloat(o.roe) || null,
        yield: parseFloat(o.yeild) || null,
        eva: o.eva_type || '',
        date: o.date || '',
      };
      if (rec.code) out.byCode[String(rec.code).toUpperCase()] = rec;
      if (rec.name) out.byName[rec.name] = rec;
      if (rec.date) out.date = rec.date;
    }
    return out;
  },

  /**
   * 板块估值：PE(动) + 市值。与资金流分开请求，
   * 因为资金流接口偶发断连，估值不该被它拖累。
   */


  /**
   * 板块列表（含资金热度）。
   *
   * 原来这里请求东财 push2 拿「主力净流入」，但那个域名
   * 在当前网络下整片不可达，每次都要白等 2 秒多才降级。
   *
   * 现在就地计算：用热力图里每个板块的
   *   涨跌幅     -> 方向
   *   成交额     -> 体量
   *   涨跌家数   -> 普涨还是权重拉动
   * 合成一个「资金热度」，含义上比单一的资金流字段更全面，
   * 而且零网络开销、永不失败。
   */
  async sectors(kind = 'industry') {
    const boards = (S.heat && S.heat.boards) || [];
    if (!boards.length) return [];

    return boards.map(b => {
      const total = (b.up || 0) + (b.down || 0);
      const upRatio = total ? (b.up || 0) / total : 0.5;

      /*
       * 热度 = 体量权重 × 方向强度
       *   体量用成交额的对数归一，避免被几个超大板块压平
       *   方向用涨跌幅乘以「上涨家数占比」，普涨的涨更有意义
       */
      const turnover = b.turnover || b.value || 0;
      const size = turnover > 0 ? Math.log10(turnover + 10) / 7 : 0.3;
      const strength = (b.pct || 0) * (upRatio * 2 - 1);

      return {
        code: b.code,
        name: b.name,
        pct: b.pct,
        up: b.up,
        down: b.down,
        stockCount: b.stockCount,
        value: b.value,
        turnover,
        // 主力净流入没有公开替代源，用加权热度近似，界面上标注清楚
        mainIn: strength * size * 1e8,
        heat: size * 100 * (1 + Math.abs(strength) / 5),
      };
    }).sort((a, b) => (b.pct || 0) - (a.pct || 0));
  },

  /**
   * 同花顺官方板块热榜（真实热度）。
   *
   * 覆盖：概念板块 20 + 行业板块 20，每项带
   *   rate         热度值（真实成交量级，不是 0-100 的拍脑袋分）
   *   rise_and_fall 板块涨跌幅
   *   hot_rank_chg 排名变化
   *   tag          涨停家数等
   *   hot_tag      连榜天数 / 首次上榜
   *   etf_name     关联 ETF 及其涨跌
   *
   * 相比第三方聚合的「情绪分」，这个数据每天都有、字段明确、覆盖稳定。
   */
  /**
   * 行情页一次拿全（融合入口）。
   *
   * 原来行情页要分别请求：热力图 + 估值 + 热榜 + 全球指数，
   * 四个源各自超时重试，任意一个慢都会拖住整页。
   * 这里统一成一个入口并发拉取，各自失败互不影响，
   * 页面只等一次 Promise.all。
   */
  async marketBundle(opt) {
    const o = opt || {};
    const jobs = {
      heat: this.heatTree().catch(() => null),
      idxVal: this.indexValuation().catch(() => null),
      hotConcept: this.thsHot('concept').catch(() => []),
      hotIndustry: this.thsHot('industry').catch(() => []),
      global: o.withGlobal ? this.allGlobal().catch(() => ({})) : Promise.resolve(null),
    };

    const r = await Promise.all(Object.values(jobs));
    const keys = Object.keys(jobs);
    const out = {};
    keys.forEach((k, idx) => { out[k] = r[idx]; });

    return {
      heat: out.heat,
      idxVal: out.idxVal,
      valuation: out.valuation,
      hot: {
        concept: out.hotConcept || [],
        industry: out.hotIndustry || [],
      },
      global: out.global,
    };
  },

  async thsHot(type) {
    const u = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate'
      + '?type=' + (type === 'industry' ? 'industry' : 'concept');
    const t = await httpGet(u, false, { tries: 3 });
    const j = JSON.parse(t);
    const list = ((j.data || {}).plate_list) || [];
    return list.map(o => ({
      code: o.code,
      name: o.name,
      heat: parseFloat(o.rate) || 0,
      pct: parseFloat(o.rise_and_fall) || 0,
      rankChg: o.hot_rank_chg || 0,
      order: o.order || 0,
      tag: o.tag || '',
      hotTag: o.hot_tag || '',
      etfName: o.etf_name || '',
      etfPct: parseFloat(o.etf_rise_and_fall),
    }));
  },

  /**
   * 板块情绪指数（第三方公开服务，含微博热搜热度 + 买卖结构）。
   * 返回 [{name, score, heat, buySell, status, statusClass, color, change, keywords}]
   */
  async momIndex() {
    // 该服务只有 HTTP（已用 network_security_config 单独放行该 IP）
    const t = await httpFirst([
      'http://212.129.244.148:8890/api/mom/index',
      'http://212.129.244.148:8890/api/mom/index?t=' + Date.now(),
    ], false, { tries: 3 });
    const j = JSON.parse(t);
    return (j.data || []).map(o => ({
      id: o.id,
      name: o.name,
      score: o.score,
      heat: o.heat_value,
      buySell: o.buy_sell_ratio,
      buyPct: o.buy_pct,
      sellPct: o.sell_pct,
      status: o.status,
      statusClass: o.status_class,
      color: o.status_color || '#6b7280',
      change: o.change,
      keywords: (o.keywords || '').split(',').filter(x => x),
      date: o.date,
      valid: o.data_valid !== false,
      sources: (o.data_sources || []).map(s => ({
        source: s.source, valid: s.valid, heat: s.heat,
      })),
    }));
  },

  /**
   * 全球指数行情（新浪）。
   *
   * 三种代码格式，字段布局不同，需分别解析：
   *   gb_*    美股：名称[0] 当前[1] 涨跌幅[2] 时间[3] 涨跌[4]
   *   b_*     全球：名称[0] 当前[1] 涨跌[2] 涨跌幅[3] 日期[6] 时间[7]
   *   int_*   简版：名称[0] 当前[1] 涨跌[2] 涨跌幅[3]
   *   hkHSI 等用腾讯格式（见 api.indices）
   */
  /** 拉取全部全球指数，按分组返回 */
  /**
   * 全球指数：按源分片并发。
   *
   * 一次性请求 30 多个代码容易超时或被限流，
   * 这里拆成「每个源每批 8 个」并发拉，谁先回来先用谁，
   * 单个分片失败只影响它自己那几个代码，不影响整页。
   */
  async allGlobal() {
    const out = {};

    const parseSina = body => {
      const re = /var hq_str_(\w+)="([^"]*)"/g;
      let m, n = 0;
      while ((m = re.exec(body))) {
        const code = m[1];
        const f = m[2].split(",");
        if (f.length < 4 || !f[0]) continue;

        let name, price, change, pct, time;
        if (code.indexOf("gb_") === 0) {
          name = f[0];
          price = parseFloat(f[1]) || 0;
          pct = parseFloat(f[2]);
          change = parseFloat(f[4]);
          time = (f[3] || "").slice(5, 16);
        } else if (code.indexOf("b_") === 0) {
          name = f[0];
          price = parseFloat(f[1]) || 0;
          change = parseFloat(f[2]);
          pct = parseFloat(f[3]);
          time = f[6] ? (f[6] || "").slice(5) + " " + (f[7] || "").slice(0, 5) : "";
        } else if (code.indexOf("sh") === 0 || code.indexOf("sz") === 0) {
          name = f[0];
          price = parseFloat(f[3]) || 0;
          const prev = parseFloat(f[2]) || 0;
          change = price - prev;
          pct = prev ? change / prev * 100 : 0;
          time = f[30] ? (f[30] || "").slice(5) + " " + (f[31] || "").slice(0, 5) : "";
        } else {
          continue;
        }
        if (!isFinite(price) || price === 0) continue;
        out[code] = {
          code, name, price,
          change: isFinite(change) ? change : 0,
          pct: isFinite(pct) ? pct : 0,
          time,
        };
        n++;
      }
      return n;
    };

    const parseTencent = body => {
      const re = /v_(\w+)="([^"]*)"/g;
      let m, n = 0;
      while ((m = re.exec(body))) {
        const f = m[2].split("~");
        if (f.length < 33) continue;
        const price = parseFloat(f[3]) || 0;
        if (!isFinite(price) || price === 0) continue;
        out[m[1]] = {
          code: m[1],
          name: f[1],
          price,
          change: parseFloat(f[31]) || 0,
          pct: parseFloat(f[32]) || 0,
          time: "",
        };
        n++;
      }
      return n;
    };

    // 港股走腾讯（新浪 hk* 字段少且是英文名），其余走新浪
    const hk = ALL_GLOBAL_CODES.filter(c => c.indexOf("hk") === 0);
    const sina = ALL_GLOBAL_CODES.filter(c => c.indexOf("hk") !== 0);

    const chunk = (arr, size) => {
      const r = [];
      for (let i = 0; i < arr.length; i += size) r.push(arr.slice(i, i + size));
      return r;
    };

    // 每批 8 个，并发请求；单批失败不影响其他批次
    const jobs = [];
    for (const part of chunk(sina, 8)) {
      jobs.push(
        httpGet("https://hq.sinajs.cn/list=" + part.join(","), true, { tries: 2 })
          .then(parseSina).catch(() => 0)
      );
    }
    for (const part of chunk(hk, 8)) {
      jobs.push(
        httpGet("https://qt.gtimg.cn/q=" + part.join(","), true, { tries: 2 })
          .then(parseTencent).catch(() => 0)
      );
    }
    await Promise.all(jobs);

    // 仍缺的：换另一个源补一次（新浪缺的用腾讯，反之亦然）
    const missing = ALL_GLOBAL_CODES.filter(c => !out[c]);
    if (missing.length) {
      const fix = [];
      for (const part of chunk(missing, 8)) {
        fix.push(
          httpGet("https://qt.gtimg.cn/q=" + part.join(","), true, { tries: 1 })
            .then(parseTencent).catch(() => 0)
        );
      }
      await Promise.all(fix);
    }
    return out;
  },

  /**
   * 财经快讯（东财公开接口，含板块异动资讯）。
   * column: 344 要闻 / 102 全球 / 345 快讯
   * 返回 [{title, summary, time, media, url, image}]
   */
  /**
   * 多渠道财经快讯。统一成 {title, summary, time, media, url} 结构。
   *
   *   eastmoney  东财要闻/快讯/全球
   *   sina       新浪 7x24（纯文本快讯，更新最勤）
   *   ths        同花顺快讯（含异动标签）
   */
  async newsFrom(src, page = 1, size = 20) {
    if (src === 'sina') {
      // 新浪有两个等价入口，主接口偶发 502 时切备用
      const qs = `page=${page}&page_size=${size}&zhibo_id=152&tag_id=0&dire=f&dpc=1`;
      const t = await httpFirst([
        'https://zhibo.sina.com.cn/api/zhibo/feed?' + qs,
        'https://zhibo.sina.com.cn/api/zhibo/feed?' + qs + '&_=' + Date.now(),
      ], false, { tries: 3 });
      const j = JSON.parse(t);
      const lst = (((j.result || {}).data || {}).feed || {}).list || [];
      return lst.map(o => {
        const text = (o.rich_text || '').trim();
        const tag = (o.tag && o.tag[0] && o.tag[0].name) || '';
        return {
          title: text,
          summary: '',
          time: (o.create_time || '').slice(5, 16),
          media: tag ? `新浪·${tag}` : '新浪财经',
          url: o.docurl || '',
        };
      }).filter(x => x.title);
    }

    if (src === 'ths') {
      const qs = `page=${page}&tag=&track=website&pagesize=${size}`;
      const t = await httpFirst([
        'https://news.10jqka.com.cn/tapp/news/push/stock/?' + qs,
        'https://news.10jqka.com.cn/tapp/news/push/stock/?' + qs + '&_=' + Date.now(),
      ], false, { tries: 3 });
      const j = JSON.parse(t);
      const lst = (j.data && j.data.list) || [];
      return lst.map(o => {
        const ts = o.ctime ? new Date(o.ctime * 1000) : null;
        const hhmm = ts
          ? `${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} `
            + `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
          : '';
        return {
          title: o.title || '',
          summary: o.digest || o.short || '',
          time: hhmm,
          media: o.tag ? `同花顺·${o.tag.split(',')[0]}` : '同花顺',
          url: o.url || o.appUrl || '',
        };
      }).filter(x => x.title);
    }

    // 东财
    const col = src === 'em-global' ? 356 : (src === 'em-macro' ? 362 : 344);
    const qs = `?client=web&biz=web_news_col&column=${col}&order=1`
      + `&needInteractData=0&page_index=${page}&page_size=${size}&req_trace=1`;
    const t = await httpFirst([
      'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns' + qs,
      'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns' + qs
        + '&_=' + Date.now(),
    ], false, { tries: 3 });
    const j = JSON.parse(t);
    const lst = (j.data && j.data.list) || [];
    return lst.map(o => ({
      title: o.title || '',
      summary: (o.summary || '').replace(/^【[^】]*】/, ''),
      time: (o.showTime || '').slice(5, 16),
      media: o.mediaName || '东方财富',
      url: o.url || o.uniqueUrl || '',
    })).filter(x => x.title);
  },

  /**
   * 重仓股（HTML 表格解析）。
   * 返回 { list:[{code,name,weightPct}], report:'YYYY-MM-DD' }，
   * 已按报告期取最新一期并去重（同一股票可能出现在多期表格里）。
   */
  async stockHoldingsEx(code, topline = 50) {
    // topline 越大拿到的持仓越多：前十大通常只覆盖 50~60% 净值，
    // 取 50 能覆盖到七八成，加权后的预估自然更贴近真实净值。
    const t = await httpGet('https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=' +
      code + '&topline=' + topline + '&year=&month=');
    const dm = t.match(/截止至：<font class='px12'>(\d{4}-\d{2}-\d{2})/);
    const rows = [];
    const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let rm;
    while ((rm = rowRe.exec(t))) {
      const cells = [];
      let cm;
      const body = rm[1];
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(body))) {
        cells.push(cm[1].replace(/<[^>]+>/g, '').trim());
      }
      const clean = cells.filter(x => x);
      if (clean.length < 4) continue;
      const ci = clean.findIndex(x => /^\d{5,6}$/.test(x));
      if (ci < 0 || ci + 1 >= clean.length) continue;
      const pctCell = [...clean].reverse().find(x => /^\d+(\.\d+)?%$/.test(x)) || '';
      rows.push({
        code: clean[ci],
        name: clean[ci + 1],
        weightPct: parseFloat(pctCell.replace('%', '')) || 0,
      });
    }
    const seen = new Set();
    const list = [];
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      list.push(r);
      if (list.length >= 10) break;
    }
    return { list, report: dm ? dm[1] : '' };
  },

};

/* ---------------- 盘中预测（持仓加权估值） ----------------
 * 原理（参照 daily-forecast）：
 *   基金当日预估涨跌% = Σ(重仓股实时涨跌% × 占净值权重%) / Σ(权重%)
 * 只用最新报告期的前十大重仓做归一化加权，现金仓位记 0。
 * 这是「估算」，晚间以基金公司公布的正式净值为准。
 */
/* ============================================================
 * 盘中预测 + 自适应校准
 *
 * 原理：
 *   基金当日涨跌 ≈ Σ(重仓股实时涨跌 × 占净值权重) / Σ(权重)
 *
 * 问题：基金的十大重仓来自季报，可能已经过期 3 个多月，
 *      基金经理早就调仓了，直接套用旧权重会持续偏差。
 *
 * 做法（每日自动累积、自我修正）：
 *   1. 收盘后用当日真实净值涨跌 与 当日预估 对比，记录误差
 *   2. 对每只重仓股，用「当日个股涨跌 × 该股权重」对误差做最小二乘修正，
 *      即把误差按各股权重与涨跌方向分摊回去，调整该股的有效权重
 *   3. 保留最近 N 天样本，权重做指数加权，越近的样本影响越大
 *   4. 校准后的权重存本地，下次预估直接用
 *
 * 这样即使季报过期，模型也会随每日净值逐步贴近真实净值。
 * ============================================================ */

/* ---------------- β 回归校准 ----------------
 *
 * 参考开源项目 fund-ledger 的做法：
 *
 *   估算涨跌 = β × R
 *
 *   R  = 重仓股加权涨跌（代表基金股票仓位的真实波动）
 *   β  = 基金净值对该波动的敏感度
 *
 * β 从最近 60 个净值日做最小二乘回归得到：
 *        β = Σ(Ri × Yi) / Σ(Ri²)
 *   Yi 是当天真实净值涨跌，Ri 是当天重仓股加权涨跌。
 *
 * 相比「按贡献分摊误差」，回归的好处是：
 *   - β 有明确经济含义（股票仓位比例），不会越调越离谱
 *   - 主动基金只披露前十大（约 50% 仓位）时，β 会自然收敛到 0.5 附近
 *   - 单日异常不会把权重带偏
 * ---------------- */

const BETA_KEY = 'beta_v1';
const BETA_MIN_SAMPLES = 8;     // 至少 8 个样本才启用回归
const BETA_MAX_SAMPLES = 60;

const beta = {
  data: {},

  load() {
    try { this.data = JSON.parse(db.get(BETA_KEY) || '{}') || {}; }
    catch (e) { this.data = {}; }
  },

  save() {
    try { db.set(BETA_KEY, JSON.stringify(this.data)); }
    catch (e) { /* 忽略 */ }
  },

  get(code) {
    if (!this.data[code]) this.data[code] = { samples: [], beta: 1, r2: null };
    return this.data[code];
  },

  /** 记录一天的样本：R（重仓股加权涨跌）与 Y（真实净值涨跌）。 */
  addSample(code, date, R, Y) {
    if (!isFinite(R) || !isFinite(Y)) return;
    const d = this.get(code);
    if (d.samples.some(x => x.date === date)) return;
    d.samples.push({ date, R: +R.toFixed(4), Y: +Y.toFixed(4) });
    if (d.samples.length > BETA_MAX_SAMPLES) d.samples.shift();
    this.fit(code);
    this.save();
  },

  /** 最小二乘回归求 β，并算 R² 表示拟合优度。 */
  fit(code) {
    const d = this.get(code);
    const n = d.samples.length;
    if (n < BETA_MIN_SAMPLES) { d.r2 = null; return; }

    let sxy = 0, sxx = 0;
    for (const x of d.samples) {
      sxy += x.R * x.Y;
      sxx += x.R * x.R;
    }
    if (sxx <= 1e-9) { d.r2 = null; return; }

    // β 限制在 0.2~2，超出说明数据有问题，不要放飞
    d.beta = Math.max(0.2, Math.min(2, sxy / sxx));

    // R²：拟合优度，越接近 1 说明重仓股越能解释净值波动
    const meanY = d.samples.reduce((a, x) => a + x.Y, 0) / n;
    let ssTot = 0, ssRes = 0;
    for (const x of d.samples) {
      const pred = d.beta * x.R;
      ssTot += Math.pow(x.Y - meanY, 2);
      ssRes += Math.pow(x.Y - pred, 2);
    }
    d.r2 = ssTot > 1e-9 ? Math.max(0, 1 - ssRes / ssTot) : null;
  },

  /** 取该基金当前的 β；样本不足时用 1（即原始加权）。 */
  betaOf(code) {
    const d = this.data[code];
    if (!d || d.samples.length < BETA_MIN_SAMPLES) return 1;
    return d.beta;
  },

  summary(code) {
    const d = this.data[code];
    if (!d || d.samples.length < BETA_MIN_SAMPLES) return null;
    const errs = d.samples.map(x => Math.abs(x.Y - d.beta * x.R));
    const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
    const hit = d.samples.filter(x =>
      Math.sign(x.Y) === Math.sign(d.beta * x.R)).length;
    return {
      n: d.samples.length,
      beta: d.beta,
      r2: d.r2,
      mae,
      hitRate: hit / d.samples.length,
    };
  },
};

/**
 * 预测误差账本。
 *
 * 每只基金每个模型都记一本账：这段时间预测了多少次、平均差多少。
 * 差得少的模型下次给更大权重——这让整套预估能自己越来越好，
 * 而不是靠人拍一个固定比例。
 *
 * 存 localStorage，重启不丢，样本会一直累积。
 */
/**
 * 每日预测台账：记下今天每个模型给出的预估，
 * 等明天真实净值出来后用来结算误差。
 * 只有存下来，才有「预测 vs 实际」的对照，算法才能自我修正。
 */
const predLog = {
  KEY: 'predlog',
  data: null,

  load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(db.get(this.KEY) || '{}') || {}; }
    catch (e) { this.data = {}; }
    return this.data;
  },

  get(code) { return this.load()[code] || null; },

  set(code, rec) {
    const d = this.load();
    d[code] = rec;
    try { db.set(this.KEY, JSON.stringify(d)); }
    catch (e) { /* ignore */ }
  },
};

const modelBook = {
  KEY: 'modelstats',
  data: null,

  load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(db.get(this.KEY) || '{}') || {};
    } catch (e) { this.data = {}; }
    return this.data;
  },

  save() {
    try { db.set(this.KEY, JSON.stringify(this.data || {})); }
    catch (e) { /* 空间不足就算了，不影响主流程 */ }
  },

  /** 取某只基金某模型的历史平均绝对误差；没样本返回 null */
  mae(code, model) {
    const d = this.load();
    const m = d[code] && d[code][model];
    if (!m || !m.n) return null;
    return m.sumAbs / m.n;
  },

  /** 记一次误差，同时保留最近几次的明细供趋势判断 */
  record(code, model, err) {
    if (!isFinite(err)) return;
    const d = this.load();
    if (!d[code]) d[code] = {};
    if (!d[code][model]) d[code][model] = { n: 0, sumAbs: 0, recent: [] };
    const m = d[code][model];
    // 指数衰减：老样本权重逐渐降低，让模型能跟上市场变化
    m.sumAbs = m.sumAbs * 0.97 + Math.abs(err);
    m.n = Math.min(m.n * 0.97 + 1, 200);

    /*
     * 明细保留**符号**（正 = 高估，负 = 低估），累计值仍用绝对值。
     *
     * 符号是判断误差性质的关键线索：
     *   符号来回跳 → 多半是指数选错或 β 漂了
     *   持续同向   → 多半是基金换仓，旧持仓已经失效
     * 只存绝对值的话，AI（和 trendFactor）都只能看到「差多少」，
     * 看不出「往哪偏」。
     */
    if (!m.recent) m.recent = [];
    m.recent.push(+err.toFixed(3));
    if (m.recent.length > 8) m.recent.shift();
  },

  /**
   * 误差是否在恶化。
   *
   * 全部样本平均误差看不出「最近才开始变差」——老样本太多会把它稀释掉。
   * 这里单独比最近 3 次和之前几次：最近明显变差，往往意味着
   * 基金已经换仓，而手上的季报还是旧的。
   *
   * 返回 1 表示正常，越小表示越不可信（最低 0.35）。
   */
  trendFactor(code, model) {
    const d = this.load();
    const m = d[code] && d[code][model];
    if (!m || !m.recent || m.recent.length < 5) return 1;

    // recent 现在带符号（见 record），比较"误差大小"要先取绝对值
    const r = m.recent.map(Math.abs);
    const last3 = r.slice(-3);
    const before = r.slice(0, -3);
    if (!before.length) return 1;

    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const nowErr = avg(last3);
    const oldErr = avg(before);
    if (oldErr < 1e-6) return 1;

    const ratio = nowErr / oldErr;
    // 误差没变大就正常；放大得越多，压得越狠
    if (ratio <= 1.2) return 1;
    return Math.max(0.35, 1 - (ratio - 1.2) * 0.5);
  },

  /** 概览：这只基金各模型的误差排行 */
  summary(code) {
    const d = this.load();
    const row = d[code] || {};
    const out = [];
    for (const k in row) {
      const m = row[k];
      if (!m.n) continue;
      out.push({ model: k, n: +m.n.toFixed(1), mae: +(m.sumAbs / m.n).toFixed(3) });
    }
    out.sort((a, b) => a.mae - b.mae);
    return out;
  },
};

/**
 * 多模型融合。
 *
 * 单个模型都有各自的失效场景：
 *   指数法   —— 基金换了跟踪标的、或者是指数增强偏离大时会偏
 *   重仓法   —— 季报数据过期（最长可能滞后 4 个月）时会偏
 *   近期均值 —— 只适合波动极小的债基，遇到行情变化就失灵
 *
 * 与其赌某一个，不如都算出来，按各自的历史误差反向加权：
 *
 *   w = 1 / (mae + 0.1)
 *   预估 = Σ(w × est) / Σ(w)
 *
 * 误差越小权重越大，没样本的先给一个温和的默认权重，
 * 跑几天后自然收敛到最准的那个模型上。
 */
function fuseModels(code, cands, type) {
  const list = cands.filter(c => c && isFinite(c.est));
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  /*
   * 没有历史样本时的先验权重。
   *
   * 按基金类型的本质来定，而不是拍脑袋：
   *   指数基金的定义就是跟踪指数，指数法当然应该主导，
   *     重仓法只用来捕捉增强策略带来的偏离；
   *   主动基金没有指数可跟，重仓法是主力；
   *   债基波动只在万分之几，近期均值最稳，指数法容易放大噪声。
   */
  const prior = { index: 0.3, holdings: 1.0, recent: 0.4 };
  if (type === 'index') { prior.index = 2.0; prior.holdings = 0.5; }
  else if (type === 'qdii') { prior.index = 1.5; prior.holdings = 0.7; }
  else if (type === 'bond') { prior.index = 0.7; prior.holdings = 0.3; prior.recent = 1.2; }

  let wsum = 0, esum = 0;
  const parts = [];
  for (const c of list) {
    /*
     * 权重由三部分相乘：
     *   prior  类型先验（这类基金该信谁）
     *   conf   本次拟合的置信度（r2 / 持仓覆盖率）
     *   fuzzy  历史误差（跑得久了就是它说了算）
     *
     * 只用历史误差的话，头几天全是瞎猜；
     * 只用先验又会一直不给数据让路。三个一起算才平滑。
     */
    let conf = 0.6;
    if (c.r2 != null) conf = Math.min(1, Math.max(0.15, c.r2));
    else if (c.covered != null) conf = Math.min(1, Math.max(0.2, c.covered));

    /*
     * 持仓法额外乘一个新鲜度：季报越旧越不可信。
     * 这是零成本的先验，不用等误差累积就能先把旧数据的权重压下去。
     */
    if (c.method === 'holdings' && c.report) {
      conf *= holdingsFreshness(c.report);
    }

    const mae = modelBook.mae(code, c.method);
    const histW = mae == null ? 1 : 1 / (mae + 0.1);

    /*
     * 误差趋势：最近几次明显变差，说明这个模型失效了。
     * 最常见的原因就是基金已经换仓，而手上的季报还是旧的，
     * 持仓加权的方向和实际净值脱节，误差会突然抬起来。
     */
    const trend = modelBook.trendFactor(code, c.method);

    /*
     * AI 给出的权重乘数。
     *
     * 它读的是「今日差异 + 历史差异 + 持仓新鲜度」，能判断出
     * 「基金经理换仓了」还是「指数 β 漂了」这类本地算不出的原因。
     * 取值已被钳制在 0.6~1.5，且置信度不足时压根不会产生；
     * 没分析过、分析过期、或 AI 关着，这里都是 1 —— 完全不影响原逻辑。
     */
    const aiW = ai.weightFor(code, c.method);

    const w = (prior[c.method] || 0.5) * conf * histW * trend * aiW;

    wsum += w;
    esum += w * c.est;
    parts.push({
      method: c.method,
      est: +c.est.toFixed(4),
      w: +w.toFixed(4),
      conf: +conf.toFixed(2),
      mae,
      trend,
      aiW,
    });
  }
  if (!wsum) return list[0];

  // 以权重最高的那个模型为主体返回，保留它带来的元信息
  const best = list.reduce((a, b) => {
    const wa = modelBook.mae(code, a.method);
    const wb = modelBook.mae(code, b.method);
    return (wa == null ? 9 : wa) <= (wb == null ? 9 : wb) ? a : b;
  });

  const out = Object.assign({}, best);
  out.est = esum / wsum;
  out.method = 'fused';
  out.fusedFrom = parts;
  out.beta = best.beta;
  out.indexName = best.indexName;
  out.indexCode = best.indexCode;
  out.note = '多模型融合';
  return out;
}

const predict = {
  /**
   * 盘中预估入口：按基金类型选预测方法。
   *
   * 不同类型的基金涨跌驱动因素完全不同，用一套方法套所有基金必然不准：
   *
   *   指数基金  跟指数走。用「指数实时涨跌 × 跟踪系数 β」，
   *             β 由指数与该基金历史日涨跌回归得到，
   *             增强型、费率、现金仓位、跟踪误差全部折算进 β。
   *   QDII      跟海外指数走，还要叠加汇率，且净值天然滞后。
   *   债券基金  跟债券指数走，拿沪深300去预测债基是必然离谱的。
   *   货币基金  净值恒为 1，没有涨跌可预测，收益看万份收益。
   *   主动型    没有可跟踪的指数，才退回前十大重仓加权。
   */
  async one(code) {
    let full = S.full[code];
    if (!full) {
      try { full = await api.fundFull(code); S.full[code] = full; }
      catch (e) { full = null; }
    }
    const type = full ? full.type : 'mix';

    // 货币基金净值恒为 1，算涨跌没有意义
    if (type === 'money') {
      return {
        code, type, est: null, raw: 0, beta: 1,
        method: 'money',
        note: '货币基金净值恒为 1，收益按万份收益计',
        at: nowHHMM(),
      };
    }

    /*
     * 并行算出所有可用模型的结果，再按历史误差融合。
     *
     * 以前是「指数法失败就退回重仓法」的硬切换，
     * 切换点很脆弱：指数法只要 r2 差一点就整只基金换算法，
     * 而两只模型其实都在提供有效信息。
     *
     * 现在两个都算，让数据自己决定听谁的。
     */
    const cands = [];

    if (type === 'index' || type === 'qdii' || type === 'bond') {
      const r = await predict.byIndex(code, full, type);
      if (r && r.est != null) cands.push(r);
    }

    if (type === 'bond') {
      const r = predict.byRecentMean(code, full, type);
      if (r) cands.push(r);
    }

    // 重仓法对主动基金是主力，对指数基金也能提供一层交叉验证
    try {
      const r = await predict.byHoldings(code, type);
      if (r && r.est != null) {
        /*
         * 持仓回演：验证这套季报持仓还成不成立。
         *
         * 季报最坏情况滞后近四个月，基金可能早就换仓了。
         * 把持仓丢回历史里跑一遍，看它还能不能解释基金的真实净值走势：
         *   解释得了(R² 高) -> 持仓仍然有效，正常给权重
         *   解释不了(R² 低) -> 持仓已经过期，直接压低它在融合里的分量
         *
         * 这比只看报告期日期准得多，也比等误差累积快得多。
         */
        if (r.holdingsList) {
          try {
            const rp = await predict.replayHoldings(code, r.holdingsList, r.reportDate);
            if (rp) {
              r.replay = rp;
              // 回演 R² 直接当作这次持仓的置信度
              r.covered = Math.min(r.covered, Math.max(0.15, rp.r2));
            }
          } catch (e) { /* 回演失败不影响主流程 */ }
        }
        cands.push(r);
      }
    } catch (e) { /* 没有季报数据就算了 */ }

    const fused = fuseModels(code, cands, type);
    if (fused) return fused;

    // 全部模型都算不出来（比如新基金还没数据）
    return null;
  },

  /**
   * 指数法预测。
   *
   * 步骤：
   *   1. 从基金名认出跟踪的指数
   *   2. 拉指数日线，和基金历史净值按日期对齐
   *   3. 回归出 β 和 R²（R² 太低说明这基金根本不跟这个指数，放弃）
   *   4. 算出「基金还没反映的那段指数涨跌」
   *   5. 预估 = 这段涨跌 × β
   *
   * 第 4 步是准的关键：基金最新净值是 T 日，QDII 可能是 T-2，
   * 那么指数从 T+1 到今天的累积涨跌，才是净值接下来要补上的部分。
   */
  async byIndex(code, full, type) {
    if (!full || !full.trend || full.trend.length < 25) return null;

    const idx = indexOf(full.name);
    if (!idx) return null;

    let hist;
    try { hist = await api.indexHistory(idx.code, 120); }
    catch (e) { return null; }
    if (!hist || hist.length < 25) return null;

    // 汇率：QDII 净值以人民币计价，海外资产涨跌要按汇率折算
    let fxPct = 0;
    if (type === 'qdii') {
      const fc = idx.code.indexOf('us') === 0 ? 'fx_susdcny'
        : (idx.code.indexOf('hk') === 0 ? 'fx_shkdcny' : null);
      if (fc) {
        try { fxPct = await api.fxChange(fc) || 0; } catch (e) { fxPct = 0; }
      }
    }

    // 日期对齐后回归
    const idxMap = Object.create(null);
    for (const d of hist) idxMap[d.date] = d.pct;

    const pairs = [];
    for (const t of full.trend) {
      const ip = idxMap[t.date];
      if (ip == null || t.pct == null || !isFinite(ip) || !isFinite(t.pct)) continue;
      pairs.push({ r: ip, y: t.pct });
    }
    const reg = regressBeta(pairs);
    if (!reg) return null;

    // 相关性太差：说明指数认错了，或者这是只主动基金。
    // 债基波动本来就小、噪声占比高，门槛放低一些，
    // 只要方向大致对，比直接不给预估有用。
    const minR2 = type === 'bond' ? 0.12 : 0.3;
    if (reg.r2 < minR2) return null;

    // 基金净值还没反映的指数累积涨跌
    const navDate = full.latest ? full.latest.date : null;
    let acc = 1, days = 0;
    for (const d of hist) {
      if (navDate && d.date <= navDate) continue;
      if (!isFinite(d.pct)) continue;
      acc *= (1 + d.pct / 100);
      days += 1;
    }

    if (!days) {
      // 今日净值已公布，没有待补涨跌
      return {
        code, type, est: null, raw: 0, beta: reg.beta,
        method: 'index', indexName: idx.name, indexCode: idx.code,
        note: '今日净值已公布', at: nowHHMM(),
      };
    }

    let racc = (acc - 1) * 100;

    // QDII：叠加同期汇率变动
    if (fxPct) racc = ((1 + racc / 100) * (1 + fxPct / 100) - 1) * 100;

    const est = racc * reg.beta;

    return {
      code, type,
      est,
      raw: racc,
      beta: reg.beta,
      r2: reg.r2,
      samples: reg.n,
      method: 'index',
      indexName: idx.name,
      indexCode: idx.code,
      lagDays: full.lagDays,
      fxPct: fxPct || null,
      covered: 1,
      missing: [],
      parts: [],
      report: full.latest ? full.latest.date : '',
      at: nowHHMM(),
      fit: beta.summary(code),
    };
  },

  /**
   * 近期均值法（债券基金兜底）。
   *
   * 纯债基金没有重仓股，跟债券指数也常常对不齐，
   * 但它的日涨跌非常稳定——常年就在万分之几到千分之一之间。
   * 与其不给数字，不如用最近 20 个交易日的中位数作为估计。
   *
   * 用中位数而不是均值：个别资金大额进出会造成异常单日波动，
   * 均值会被这类离群值带偏，中位数不会。
   */
  byRecentMean(code, full, type) {
    if (!full || !full.trend || full.trend.length < 25) return null;
    // 排除最后一条（它对应的就是待预测的那天）
    const win = full.trend.slice(-22, -1);
    const pcts = win.map(x => x.pct).filter(v => v != null && isFinite(v));
    if (pcts.length < 10) return null;

    pcts.sort((a, b) => a - b);
    const med = pcts[Math.floor(pcts.length / 2)];

    return {
      code, type: type || 'bond',
      est: med,
      raw: med,
      beta: 1,
      method: 'recent',
      samples: pcts.length,
      covered: 1,
      missing: [],
      parts: [],
      report: full.latest ? full.latest.date : '',
      at: nowHHMM(),
      note: '按近 20 日波动中位数估计',
      fit: null,
    };
  },

  /**
   * 持仓回演：验证手上的季报持仓是否还成立。
   *
   * 思路很直接——把当前的季报持仓拿到历史里跑一遍：
   * 用每只重仓股过去 20 个交易日的真实涨跌，按占净值比例加权，
   * 拼出一条「如果持仓一直没变，基金应该走的曲线」，
   * 再和基金真实的净值曲线做回归。
   *
   *   R² 高  说明这套持仓确实还在解释这只基金的涨跌，可以信
   *   R² 低  说明基金经理早换仓了，手上的季报已经过期，
   *          再怎么加权都是在算一只已经不存在的组合
   *
   * 这是判断「持仓新不新」唯一靠得住的办法：
   * 光看报告期日期只能猜，跑一遍数据才知道真假。
   *
   * 成本控制：只取前 8 大（已覆盖净值主体），结果缓存一天。
   */
  async replayHoldings(code, holdings, report) {
    if (!holdings || !holdings.length) return null;

    const ck = S.replay[code];
    if (ck && Date.now() - ck.at < 86400000) return ck.score;

    const top = holdings.slice(0, 4).filter(x => toTxCode(x.code));
    if (top.length < 3) return null;

    const DAYS = 20;
    const series = await Promise.all(top.map(async x => {
      try {
        const h = await api.indexHistory(toTxCode(x.code), DAYS + 4);
        return h && h.length >= 10 ? { w: x.weightPct, hist: h } : null;
      } catch (e) { return null; }
    }));

    const valid = series.filter(Boolean);
    if (valid.length < 3) return null;

    // 对齐到共同长度，避免各只交易日不一致
    const n = Math.min.apply(null, valid.map(v => v.hist.length), DAYS);
    const totalW = valid.reduce((acc, v) => acc + v.w, 0);
    if (!totalW) return null;

    // 加权拼出「理论净值日涨跌」
    const synth = Object.create(null);
    for (let k = 1; k < n; k++) {
      let dayRet = 0;
      let date = null;
      for (const v of valid) {
        const h = v.hist[v.hist.length - n + k];
        if (!date) date = h.date;
        dayRet += v.w * (h.pct || 0);
      }
      if (date) synth[date] = dayRet / totalW;
    }

    const trend = S.full[code] && S.full[code].trend;
    if (!trend) return null;

    const pairs = [];
    for (const t of trend) {
      const r = synth[t.date];
      if (r == null || t.pct == null) continue;
      pairs.push({ r, y: t.pct });
    }

    const reg = regressBeta(pairs);
    const score = reg
      ? { beta: +reg.beta.toFixed(3), r2: +reg.r2.toFixed(3), n: reg.n }
      : null;

    S.replay[code] = { at: Date.now(), score };
    return score;
  },

  /**
   * 重仓股加权法（主动基金用）。
   * 用季报前十大重仓的实时涨跌，按占净值比例加权，再乘 β 校准。
   */
  async byHoldings(code, type) {
    /*
     * 季报持仓三个月才变一次，没必要每次预估都重新下载。
     * 缓存一天：既省流量，又保证新报告出炉后第二天就能用上。
     */
    let h = S.holdCache[code];
    const DAY = 86400000;
    if (h && (Date.now() - h.at) < DAY) {
      h = h.data;
    } else {
      try {
        const fresh = await api.stockHoldingsEx(code, 50);
        // 记下报告期，新一季的季报出来后会自动替换
        fresh.fetchedAt = Date.now();
        S.holdCache[code] = { data: fresh, at: Date.now() };
        h = fresh;
      } catch (e) {
        // 网络失败：有旧数据就先用旧的，总比没有强
        h = h ? h.data : null;
      }
    }
    if (!h || !h.list.length) return null;

    const quotes = await api.stockQuotes(h.list.map(x => x.code));

    const parts = [];
    let totalW = 0;
    for (const x of h.list) {
      totalW += x.weightPct;
      parts.push({ ...x, effW: x.weightPct });
    }
    if (!totalW) return null;

    const out = [];
    let est = 0;
    const miss = [];
    for (const x of parts) {
      const q = quotes[x.code];
      if (q == null || !isFinite(q)) { miss.push(x.name); continue; }
      const contrib = q * x.effW / totalW;
      est += contrib;
      out.push({
        code: x.code, name: x.name,
        weightPct: x.weightPct,
        effW: +x.effW.toFixed(2),
        pct: q, contrib,
      });
    }
    if (!out.length) return null;

    const bt = beta.betaOf(code);
    const raw = est;

    /*
     * 覆盖率 = 重仓股合计占净值的比例。
     *
     * 这个数决定了重仓法有多可信：
     * 取到 30 只可能覆盖七成净值，预估就靠谱；
     * 只覆盖三成，剩下七成是黑的，结论只能算参考。
     * 以前这里算的是「重仓股内部占比」，恒等于 1，等于没有信息。
     */
    const coverage = Math.min(1, totalW / 100);

    return {
      code, type: type || 'mix',
      est: raw * bt,
      raw,
      beta: bt,
      method: 'holdings',
      covered: coverage,
      holdingsList: h.list,
      reportDate: h.report,
      report: h.report,
      parts: out,
      missing: miss,
      at: nowHHMM(),
      fit: beta.summary(code),
    };
  },

  /** 批量计算（并发，最多 4 只同时）。 */
  async many(codes) {
    const out = {};
    const queue = [...codes];
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const r = await predict.one(c);
          if (r) out[c] = r;
        } catch (e) { /* ignore */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, codes.length) }, worker));
    return out;
  },

  /**
   * 用当日真实净值校准所有持仓。
   *
   * 触发时机：拿到最新净值且该净值日期是「今天」（已收盘公布）时。
   * 同一天只校准一次，避免重复学习把权重带偏。
   *
   * 注意：指数法不需要这里的 β 校准（β 每次都是现场回归的），
   * 只有重仓法依赖历史样本。
   */
  async learnAll() {
    let learned = 0;
    let settled = 0;

    for (const h of S.holdings) {
      const nav = S.nav[h.code];
      if (!nav || !isFinite(nav.pct) || !nav.date) continue;

      const d = beta.get(h.code);
      if (d.samples.some(x => x.date === nav.date)) continue;

      const pr = S.predict[h.code] || await predict.one(h.code);
      if (!pr) continue;

      /*
       * 结算误差：把上一次每个模型的预测值与今天的真实涨跌对比，
       * 记进 modelBook。这是整套预估能越来越准的来源——
       * 每天的真实净值就是一次免费的标注数据。
       */
      const prevLog = predLog.get(h.code);
      if (prevLog && prevLog.date !== nav.date && prevLog.models) {
        for (const m in prevLog.models) {
          const pe = prevLog.models[m];
          if (!isFinite(pe)) continue;
          modelBook.record(h.code, m, pe - nav.pct);
        }
        modelBook.save();
        settled++;
      }

      // 记下这次的各模型预测，等下一个净值日结算
      if (pr.fusedFrom) {
        const m = {};
        for (const f of pr.fusedFrom) m[f.method] = f.est;
        predLog.set(h.code, { date: nav.date, models: m });
      } else if (isFinite(pr.est)) {
        predLog.set(h.code, { date: nav.date, models: { [pr.method]: pr.est } });
      }

      // 重仓法还要保留 β 样本（历史权重校准）
      if (isFinite(pr.raw) && pr.method === 'holdings') {
        beta.addSample(h.code, nav.date, pr.raw, nav.pct);
      }
      learned++;
    }

    /*
     * 静默保存，不弹提示。
     *
     * 这是每天自动跑的后台校准，用户并没有主动做什么，
     * 每次启动弹一句「已用今日净值校准 N 只基金」纯属打扰。
     * 校准结果体现在预估准确度上，不需要报告。
     */
    if (learned) {
      beta.save();
      diag.info('净值校准 ' + learned + ' 只 · 结算 ' + settled + ' 条误差');
    }
    if (settled) modelBook.save();
    return learned;
  },
};

/**
 * 用真实历史回演出误差样本，作为 AI 校准的「启动数据」。
 *
 * 为什么需要它：
 *   AI 要对比「今日差异 + 历史差异」才能判断误差性质，但新装用户、
 *   或刚加进来的基金，modelBook 里一条样本都没有 —— 点「立即校准」
 *   只会得到「样本不足，暂不需要校准」，功能形同没接。
 *
 *   而我们其实**手上有完整的历史**：基金净值历史（S.full）和跟踪指数
 *   历史（api.indexHistory）本来就要拉。把两者按日期对齐、逐日比一遍，
 *   就能算出真实的误差序列 —— 全程不需要编造任何一个数。
 *
 * 回演的是 index 法：
 *     预估 = 指数当日涨跌 × β
 *     误差 = 预估 - 实际
 * holdings 法不回演：它需要逐日的历史个股行情（几十只 × N 天），
 * 成本高，而且季报持仓早就过期，回演出来也没有参考价值。
 *
 * 只在样本严重不足时跑一次，结果按「基金 + 净值最新日期」缓存。
 */
async function bootstrapErrorHistory(code) {
  const h = S.holdings.find(x => x.code === code);
  if (!h) return 0;
  const full = S.full[code];
  const tr = full && full.trend;
  if (!tr || tr.length < 8) return 0;

  // 同一批历史只回演一次
  const ck = 'boot_' + code + '_' + tr[tr.length - 1].date;
  if (db.get(ck)) return 0;

  /*
   * 跟踪指数。
   *
   * 认不出来（主动基金、名字里没有指数关键词）**不能直接放弃** ——
   * 那样主动基金的新用户永远只能看到「样本不足」，而主动基金
   * 恰恰是最需要校准的那一类（它的持仓季报最容易过期）。
   * 退而求其次用沪深300 当**代理指数**：任何 A 股基金都和它有一定
   * 相关性，回归出来的 β 能把「这只基金相对大盘的偏离」量化出来，
   * 误差模式是有意义的。只是要如实告诉 AI 这是代理，不是真实跟踪标的。
   */
  const idx = indexOf(h.name || '');
  const proxy = !idx;
  const idxCode = idx ? idx.code : 'sh000300';
  if (proxy) S.bootProxy = Object.assign({}, S.bootProxy, { [code]: true });

  let hist = null;
  try { hist = await api.indexHistory(idxCode, 40); } catch (e) { hist = null; }
  if (!hist || hist.length < 8) return 0;

  const imap = Object.create(null);
  for (const b of hist) {
    const d = String(b.date || '').slice(0, 10);
    if (d && isFinite(b.close) && b.close > 0) imap[d] = b.close;
  }
  const navMap = Object.create(null);
  for (const t of tr) if (t && t.date) navMap[t.date] = t.nav;

  // 只取两个序列都有数据的日期，按时间升序
  const dates = Object.keys(navMap).filter(d => imap[d]).sort();
  if (dates.length < 8) return 0;

  /*
   * 先把每天的两边涨跌都算出来。
   * 单日涨跌超过 15% 的剔除：那天多半是分红除息或份额拆分，
   * 单位净值本来就该跳，拿它当「预测误差」会把 AI 带偏。
   */
  const pairs = [];
  for (let i = 1; i < dates.length; i++) {
    const d0 = dates[i - 1], d1 = dates[i];
    const n0 = navMap[d0], n1 = navMap[d1];
    const i0 = imap[d0], i1 = imap[d1];
    if (!(n0 > 0) || !(i0 > 0)) continue;
    const actual = (n1 / n0 - 1) * 100;
    const idxPct = (i1 / i0 - 1) * 100;
    if (!isFinite(actual) || !isFinite(idxPct)) continue;
    if (Math.abs(actual) > 15 || Math.abs(idxPct) > 15) continue;
    pairs.push({ r: idxPct, y: actual });
  }
  if (pairs.length < 8) return 0;

  /*
   * β：优先用已有的回演分数（它是对着真实净值拟合出来的），
   * 否则**就用这批数据自己回归一个** ——
   * 主动基金不会走 predict.byIndex，拿不到现成的 β。
   */
  let betaV = null;
  const bt = (S.replay[code] && S.replay[code].score) || null;
  if (bt && isFinite(bt.beta) && bt.beta > 0) betaV = bt.beta;
  if (betaV == null) {
    const rg = regressBeta(pairs);
    if (rg && isFinite(rg.beta) && rg.beta > 0) betaV = rg.beta;
  }
  if (betaV == null) betaV = 1;

  // 再逐日算误差写进账本
  let n = 0;
  for (const p of pairs) {
    modelBook.record(code, 'index', p.r * betaV - p.y);
    n++;
    if (n >= 12) break;      // 12 条足够看出误差模式了
  }
  if (n) modelBook.save();
  db.set(ck, '1');
  if (n) diag.info('AI 启动数据 ' + code + ' · 回演 ' + n + ' 条'
    + (proxy ? '（代理指数 ' + idxCode + '，β=' + betaV.toFixed(2) + '）' : '（' + idxCode + '）'));
  return n;
}

/* ---------------- AI 估值校准 ----------------
 *
 * 定位：**只做元决策，不做数值回归**。
 *
 * 为什么不让它直接算净值：
 *   LLM 是采样输出，同一个输入两次可能给出 0.93 和 0.9322；
 *   延迟十几秒且不确定，而盘中估值要频繁刷新。
 *   数值回归交给本地的最小二乘（predict），它又快又可复现。
 *
 * AI 真正擅长的是「看模式、说原因」：
 *   本地只能知道「误差变大了」，说不出为什么。把「今日差异 +
 *   历史差异 + 持仓新鲜度」摆给它，它能判断出是基金经理换仓了、
 *   还是指数 β 漂了、还是季报过期了，并给出两个模型的权重调整。
 *
 * 四层保护（对应「别让 AI 一直崩溃」）：
 *   1. **结果缓存**：同一只基金 + 同一份报告期 + 同一批误差只调一次；
 *   2. **失败退避**：连续失败进入冷却，冷却期内直接跳过，不反复重试；
 *   3. **串行 + 超时**：同时最多一个请求在飞，单次 90 秒；
 *   4. **完全降级**：任何一步失败都不影响原有预估，只是不校准而已。
 * ---------------- */
const ai = {
  /*
   * 开源版**不内置任何 API Key**。
   *
   * 内置 key 有两个硬伤：一是任何人反编译 APK 就能取走，直接烧号主的额度；
   * 二是把这个 key 提交到公开仓库，等于当场公开 —— GitHub 的密钥扫描
   * 几分钟内就会给号主发告警，运气差直接被轮换。
   * 所以改成「用户自己填」：key 只存在他自己手机的本地库里，不上传、不外发。
   */
  KEYNAME: 'aiKey',
  URLNAME: 'aiUrl',
  MODELNAME: 'aiModel',
  CACHE: 'aitune',
  STATE: 'aistate',

  /**
   * 默认接口地址。
   *
   * 走的是 OpenAI 兼容协议（/v1/chat/completions + messages 数组），
   * 所以理论上任何兼容实现都能填 —— 官方 API、自建代理、本地 Ollama
   * 的 /v1 端口、各家云厂商的兼容端点，都可以。
   */
  DEFAULT_URL: 'https://token.sensenova.cn/v1/chat/completions',

  /**
   * 默认模型：deepseek-v4-flash。
   *
   * 实测这批候选里它最合适 —— 支持 json_mode（输出可直接 JSON.parse）、
   * 带推理（能给出「为什么这么判断」）、免费额度够跑日常校准。
   * 注意 sensenova-6.8-flash-lite 虽然也在 /v1/models 列表里，
   * 但它的引擎经常返回 500，不适合放进自动流程。
   */
  DEFAULT_MODEL: 'deepseek-v4-flash',

  /* 运行参数 */
  FAIL_LIMIT: 3,              // 连续失败几次开始冷却
  COOL_MS: 30 * 60 * 1000,    // 冷却 30 分钟
  GAP_MS: 1200,               // 两次调用之间的最小间隔（串行节流）
  TIMEOUT: 90000,
  MIN_SAMPLES: 3,             // 误差样本少于这个数不分析，没意义

  busy: false,
  _lastAt: 0,

  get key() {
    try { return db.get(this.KEYNAME) || ''; } catch (e) { return ''; }
  },
  set key(v) { try { db.set(this.KEYNAME, String(v || '').trim()); } catch (e) {} },

  get url() {
    try { return db.get(this.URLNAME) || this.DEFAULT_URL; } catch (e) { return this.DEFAULT_URL; }
  },
  set url(v) { try { db.set(this.URLNAME, String(v || '').trim() || this.DEFAULT_URL); } catch (e) {} },

  get model() {
    try { return db.get(this.MODELNAME) || this.DEFAULT_MODEL; } catch (e) { return this.DEFAULT_MODEL; }
  },
  set model(v) { try { db.set(this.MODELNAME, String(v || '').trim() || this.DEFAULT_MODEL); } catch (e) {} },

  /** 填了 key 才算可用：没有 key 时功能静默关闭，不报错、不打扰 */
  get configured() { return !!this.key; },

  get on() { return this.configured && db.get('aiOn') !== '0'; },
  set on(v) { db.set('aiOn', v ? '1' : '0'); },

  _cache() { try { return JSON.parse(db.get(this.CACHE) || '{}') || {}; } catch (e) { return {}; } },
  _saveCache(d) { try { db.set(this.CACHE, JSON.stringify(d || {})); } catch (e) {} },
  _state() {
    try { return JSON.parse(db.get(this.STATE) || '{}') || {}; }
    catch (e) { return {}; }
  },
  _saveState(s) { try { db.set(this.STATE, JSON.stringify(s || {})); } catch (e) {} },

  /** 冷却中？冷却期内一律不发起请求，避免失败时反复打接口 */
  cooling() {
    const s = this._state();
    return !!(s.coolUntil && Date.now() < s.coolUntil);
  },

  /**
   * 收集一只基金的证据包。
   * 只取最近若干条误差，控制上下文长度 —— 给得越多越慢越贵，
   * 而最近的误差才反映当前持仓状态。
   */
  evidence(code) {
    const h = S.holdings.find(x => x.code === code);
    if (!h) return null;
    const book = modelBook.load()[code] || {};

    // 各模型的误差明细（最近 8 条），是本次分析的主角
    const series = {};
    let total = 0;
    for (const m in book) {
      const r = (book[m].recent || []).slice(-8);
      if (!r.length) continue;
      series[m] = r;
      total += r.length;
    }
    if (total < this.MIN_SAMPLES) return null;

    const full = S.full[code] || {};
    const bt = (S.replay[code] && S.replay[code].score) || null;
    const pr = S.predict[code] || null;

    // 报告期 / 发布日 / 新鲜度 —— 这是判断「持仓还成不成立」的关键线索
    const hc = S.holdCache[code] && S.holdCache[code].data;
    const report = (hc && hc.report) || S.reportOf[code] || null;
    const pub = report ? reportPublishDate(report) : null;

    return {
      code,
      name: h.name || code,
      type: full.type || h.type || null,
      shares: +h.shares || 0,
      series,
      report,
      publishDate: pub,
      daysSincePublish: pub ? dayGap(pub) : null,
      freshness: report ? +holdingsFreshness(report).toFixed(2) : null,
      beta: bt ? bt.beta : null,
      r2: bt ? bt.r2 : null,
      // 主动基金的 β 是用沪深300 代理回归出来的，得如实告诉 AI ——
      // 否则它会以为这是基金真实的跟踪标的，把误差归因搞反
      indexName: (S.bootProxy && S.bootProxy[code])
        ? '沪深300（代理）'
        : (pr && pr.indexName ? pr.indexName : null),
      todayEst: pr && isFinite(pr.est) ? pr.est : null,
      todayActual: todayPctOf(code),
    };
  },

  /**
   * 缓存指纹。
   * 报告期变了（新季报）或误差序列变了（有新样本）才需要重新分析。
   */
  fingerprint(ev) {
    const sig = Object.keys(ev.series).sort()
      .map(k => k + ':' + ev.series[k].join(',')).join('|');
    return (ev.report || '-') + '#' + sig.length + '#' + sig.slice(-40);
  },

  /** 系统提示词 —— 定义角色、输出契约、取值范围 */
  SYS: [
    '你是一个基金盘中估值模型的校准助手。',
    '用户的手机 App 用两种方法预估基金当日涨跌：',
    '  index    —— 用跟踪指数的涨跌 × 回归 β 推算',
    '  holdings —— 用季报前十大重仓股的实时涨跌加权',
    '两种结果再按历史误差加权融合。你的任务是读误差序列，',
    '判断误差主要来自哪里，并给出两个权重的调整系数。',
    '',
    '判断要点：',
    '- 误差符号来回跳、幅度稳定 → 大概率是指数没选对或 β 漂了，压 index',
    '- 误差突然变大且同向 → 多半是基金换仓了，旧持仓失效，压 holdings',
    '- 季报刚发布（距发布日 0~25 天）→ 持仓最新鲜，可以更信 holdings',
    '- 季报很久没更新（超过 120 天）→ 持仓早过期，别信 holdings',
    '- 债基波动只在万分之几，误差 0.1 就算很大了',
    '',
    '输出契约（严格遵守）：',
    '- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字',
    '- diagnosis: 25 字以内的中文诊断，说清误差主要来源',
    '- indexWeight / holdingsWeight: 0.5~1.5（1.0 = 保持不动）',
    '- style: 从 ["指数型","主动选股","量化","行业主题","债券","不确定"] 里选一个',
    '- confidence: 0~1，你对这次判断的把握；把握不大就老实给低分',
  ].join('\n'),

  /** 用户提示词 —— 把证据摆清楚 */
  buildUser(ev) {
    const L = [];
    L.push('基金：' + ev.code + ' ' + ev.name + (ev.type ? '（' + ev.type + '）' : ''));
    if (ev.indexName) L.push('跟踪指数：' + ev.indexName
      + (ev.beta != null ? '，回归 β=' + ev.beta.toFixed(2) : '')
      + (ev.r2 != null ? '，R²=' + ev.r2.toFixed(2) : ''));
    if (ev.shares) L.push('持有份额：' + ev.shares);
    if (ev.report) {
      L.push('最新季报：报告期 ' + ev.report
        + '，估算发布日 ' + (ev.publishDate || '--')
        + (ev.daysSincePublish != null ? '（距今 ' + ev.daysSincePublish + ' 天）' : ''));
      L.push('持仓新鲜度系数：' + ev.freshness + '（1 最准，0.25 表示手上的季报还没发布）');
    }
    if (ev.todayEst != null || ev.todayActual != null) {
      L.push('今日：预估 ' + (ev.todayEst != null ? ev.todayEst.toFixed(2) + '%' : '--')
        + '，实际 ' + (ev.todayActual != null ? ev.todayActual.toFixed(2) + '%' : '--'));
    }
    L.push('');
    L.push('各模型最近几次的误差（百分点；正=高估，负=低估，越接近 0 越准）：');
    for (const m in ev.series) L.push('  ' + m + '：' + ev.series[m].join('  '));
    L.push('');
    L.push('请给出诊断与权重调整。');
    return L.join('\n');
  },

  /** 真正发一次请求。失败返回 null，绝不抛。 */
  async call(ev) {
    if (!window.Native || !Native.httpPost) return null;
    if (!this.key) return null;          // 没填 key 就不发请求
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: this.SYS },
        { role: 'user', content: this.buildUser(ev) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    /*
     * Authorization 走参数传给原生，而不是让 Kotlin 从别处读 ——
     * API Key 只存在用户本地库，原生不持有也不落盘。
     */
    const auth = 'Bearer ' + this.key;
    const text = await nativeAsync(id => Native.httpPost(this.url, body, auth, id));
    const j = JSON.parse(text);
    if (j.error) throw new Error(j.error.message || 'api error');
    const c = j.choices && j.choices[0] && j.choices[0].message;
    if (!c) throw new Error('empty choice');
    return JSON.parse(c.content);
  },

  /** 把 AI 的原始输出钳制成安全值 */
  clamp(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v, lo, hi, dflt) => {
      const n = parseFloat(v);
      if (!isFinite(n)) return dflt;
      return Math.min(hi, Math.max(lo, n));
    };
    const conf = num(raw.confidence, 0, 1, 0);
    /*
     * 置信度太低就整条丢弃。
     * 与其按一个「它自己都没把握」的建议去调权重，不如不动 ——
     * 擅自调参比不调更危险。
     */
    if (conf < 0.4) return null;
    return {
      diagnosis: String(raw.diagnosis || '').slice(0, 60),
      indexWeight: num(raw.indexWeight, 0.6, 1.5, 1),
      holdingsWeight: num(raw.holdingsWeight, 0.6, 1.5, 1),
      style: String(raw.style || '').slice(0, 12),
      confidence: conf,
      at: nowHHMM(),
      day: todayStr(),
    };
  },

  /** 取某模型当前的 AI 权重乘数；没分析过就是 1（不影响） */
  weightFor(code, method) {
    if (!this.on) return 1;
    const rec = this._cache()[code];
    if (!rec || !rec.tune) return 1;
    const t = rec.tune;
    // 超过 7 天的建议不再采信：市场风格可能已经变了
    if (rec.day && dayGap(rec.day) > 7) return 1;
    if (method === 'index') return t.indexWeight || 1;
    if (method === 'holdings') return t.holdingsWeight || 1;
    return 1;
  },

  /**
   * 分析一只基金。命中缓存直接返回，不重复调接口。
   * 返回 { tune } 或 null；任何失败都吞掉，绝不影响主流程。
   */
  async analyze(code, force) {
    if (!this.on) return null;
    if (this.cooling()) return null;

    let ev = this.evidence(code);
    /*
     * 样本不足时，先拿真实历史回演一批出来 —— 这就是「启动数据」。
     * 不回演的话，新装用户点「立即校准」只会看到「样本不足」，
     * 而净值历史与指数历史明明就在手上。
     */
    if (!ev) {
      try {
        const got = await bootstrapErrorHistory(code);
        // 回演函数内部已经记过日志了，这里不重复记
        if (got) ev = this.evidence(code);
      } catch (e) { /* 回演失败就按样本不足处理 */ }
    }
    if (!ev) return null;
    const fp = this.fingerprint(ev);
    const cache = this._cache();
    const hit = cache[code];
    if (!force && hit && hit.fp === fp) return hit;

    // 串行 + 最小间隔：避免多只基金同时打接口
    while (this.busy) { await new Promise(r => setTimeout(r, 200)); }
    this.busy = true;
    let out = null;
    try {
      const wait = this.GAP_MS - (Date.now() - this._lastAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this._lastAt = Date.now();

      const raw = await Promise.race([
        this.call(ev),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), this.TIMEOUT)),
      ]);
      const tune = this.clamp(raw);
      if (tune) {
        out = { fp, day: todayStr(), tune, ev: { report: ev.report, freshness: ev.freshness } };
        cache[code] = out;
        this._saveCache(cache);
        // 成功：清掉失败计数
        const s = this._state();
        s.fails = 0; s.coolUntil = 0; s.lastOk = Date.now();
        this._saveState(s);
        diag.info('AI 校准 ' + code + ' · ' + tune.diagnosis
          + ' · index×' + tune.indexWeight + ' holdings×' + tune.holdingsWeight);
      } else {
        // 置信度不足：也算一次成功（接口是通的），只是没采纳
        const s = this._state(); s.fails = 0; this._saveState(s);
      }
    } catch (e) {
      /*
       * 失败退避：连续失败到阈值就冷却一段时间。
       * 不做这层的话，每次刷新都会对每只基金重试一遍，
       * 接口一旦挂掉就是「一直崩」的观感，还白烧流量。
       */
      const s = this._state();
      s.fails = (s.fails || 0) + 1;
      s.lastErr = String((e && e.message) || e).slice(0, 120);
      if (s.fails >= this.FAIL_LIMIT) {
        s.coolUntil = Date.now() + this.COOL_MS;
        diag.warn('AI 连续失败 ' + s.fails + ' 次，暂停 ' + (this.COOL_MS / 60000) + ' 分钟');
      } else {
        diag.warn('AI 调用失败', s.lastErr);
      }
      this._saveState(s);
    } finally {
      this.busy = false;
    }
    return out;
  },

  /**
   * 批量分析（串行）。
   * 在上一次数据刷新**跑完之后**调用 —— 见 refreshAll 里的调用位置。
   */
  async runAll(force) {
    if (!this.on || this.cooling()) return 0;
    const codes = S.holdings.map(h => h.code);
    let n = 0;
    for (const c of codes) {
      const r = await this.analyze(c, force);
      if (r && r.tune) n++;
    }
    if (n) { S.perfCurve = null; render(); }   // 校准变了，历史页重算
    return n;
  },

  /** 校准结果摘要（诊断页 / 设置页展示用） */
  summary() {
    const cache = this._cache();
    const s = this._state();
    const rows = [];
    for (const code in cache) {
      const r = cache[code];
      if (!r || !r.tune) continue;
      rows.push({ code, day: r.day, diagnosis: r.tune.diagnosis,
        iw: r.tune.indexWeight, hw: r.tune.holdingsWeight,
        conf: r.tune.confidence, style: r.tune.style });
    }
    return {
      on: this.on, model: this.model, url: this.url, count: rows.length, rows,
      fails: s.fails || 0,
      cooling: this.cooling(),
      coolLeft: s.coolUntil ? Math.max(0, Math.round((s.coolUntil - Date.now()) / 60000)) : 0,
      lastErr: s.lastErr || null,
      hasKey: !!this.key,
      configured: this.configured,
    };
  },
};

/* ---------------- 本地缓存（拼多多式「先出后补」） ----------------
 *
 * 手机端最影响体感的不是渲染快慢，而是「等到什么时候才有东西看」。
 *
 * 做法：
 *   1. 每次拿到新数据就写进 localStorage
 *   2. 下次启动先用缓存立刻渲染一版（哪怕是几分钟前的）
 *   3. 网络返回后再无缝替换
 *
 * 这样冷启动首屏几乎瞬时可见，不再对着「加载中」干等。
 * 缓存带时间戳，超过 TTL 会标记为过期，界面上提示数据时间。
 * ---------------- */

const cache = {
  PREFIX: 'yjbc_',
  TTL: 10 * 60 * 1000,   // 10 分钟内视为新鲜

  set(key, val) {
    /*
     * 换到 db 之后，「空间不足就清掉旧缓存再试一次」那套兜底不再需要 ——
     * IndexedDB 按磁盘配额走，不会像 localStorage 那样卡在 5MB。
     * 但保留 try：db 不可用时会退回 localStorage，那条路仍可能写失败。
     */
    try {
      db.set(this.PREFIX + key, JSON.stringify({ t: Date.now(), v: val }));
    } catch (e) { /* 放弃缓存 */ }
  },

  get(key) {
    try {
      const raw = db.get(this.PREFIX + key);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.v) return null;
      return { val: o.v, age: Date.now() - o.t, fresh: Date.now() - o.t < this.TTL };
    } catch (e) { return null; }
  },

  /** 数据年龄文案：让用户知道看到的是什么时候的数据 */
  ageText(age) {
    if (age == null) return '';
    const m = Math.floor(age / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  },
};

/* ---------------- 主题 ----------------
 * 三档：auto 跟随系统 / light 浅色 / dark 深色。
 * 只切换 <html data-theme>，颜色全由 CSS 变量接管，
 * 不重建 DOM，所以不会闪、不会丢滚动位置。
 */
const theme = {
  get mode() {
    try { return db.get('themeMode') || 'auto'; }
    catch (e) { return 'auto'; }
  },

  resolve(mode) {
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    return (window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  },

  apply(mode, animate) {
    const m = mode || this.mode;
    const resolved = this.resolve(m);
    const root = document.documentElement;

    if (animate) {
      root.classList.add('theme-anim');
      setTimeout(() => root.classList.remove('theme-anim'), 220);
    }
    root.setAttribute('data-theme', resolved);

    // 同步浏览器 UI 颜色（地址栏/状态栏），手动切主题时媒体查询不会自己变
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0e1116' : '#f2f4f7');

    try {
      if (window.Native && Native.setTheme) Native.setTheme(resolved);
    } catch (e) { /* 忽略 */ }
  },

  set(mode) {
    try { db.set('themeMode', mode); } catch (e) { /* 忽略 */ }
    this.apply(mode, true);
    render();
  },

  watch() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (this.mode === 'auto') this.apply('auto', true); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  },

  label(m) {
    return m === 'light' ? '浅色' : (m === 'dark' ? '深色' : '跟随系统');
  },
};

/* ---------------- 本地数据库 ----------------
 *
 * 为什么要这一层：
 *
 *   localStorage 只有 5~10MB，而且只能存字符串。这个 App 要存的东西
 *   已经不少了 —— 全量净值历史（每只基金 120 天）、预测台账、
 *   模型误差账本、诊断日志，后面还要加交易流水 ——
 *   一旦顶到上限，写入是**静默失败**的（调用处全都被 catch 掉了），
 *   数据神不知鬼不觉地丢。这是最难查的一类问题。
 *
 * 为什么选 IndexedDB 而不是 SQLite：
 *   这个 App 的数据全在 WebView 的 JS 侧。SQLite 得走 JS↔Java 桥，
 *   每次读写都是一次 IPC；而 holdCache / predLog 这类是高频小读写，
 *   跨进程反而更慢。IndexedDB 是浏览器原生的，支持事务与索引，
 *   容量按磁盘配额走，而且不需要动一行原生代码。
 *
 * 为什么做成「内存为真相 + 异步落盘」：
 *   IndexedDB 是异步 API，而现有代码到处是同步读
 *   （store.load() 在启动时同步调用）。所以这里在启动时一次性
 *   把全部数据读进内存，之后所有读都是同步走内存；
 *   写则先改内存（立刻生效）再把那一条异步落盘。调用方几乎不用改。
 *
 * 迁移的三条安全线：
 *   1. 值仍然存**字符串**，和 localStorage 完全一致 ——
 *      调用方原来怎么 JSON.parse 现在还怎么 parse，行为不变；
 *   2. localStorage **一个字节都不删**。新库是「再加一份」而不是
 *      「搬走」，出任何问题都能退回去；
 *   3. IndexedDB 打不开（隐私模式等）就整体退回 localStorage，
 *      功能不减，只是容量回到老样子。
 * ---------------- */
const db = {
  NAME: 'yjblite',
  STORE: 'kv',
  VER: 1,

  mem: Object.create(null),
  idb: null,
  useIDB: false,
  ready: false,
  writeCount: 0,

  /*
   * 这几个 key 的数据很小，但最要紧（丢了用户直接炸）。
   * 它们**双写** localStorage —— IndexedDB 的事务在页面被强杀时
   * 可能来不及提交，而 localStorage 是同步落盘的。
   * 剩下的大块数据（历史 / 日志 / 账本）只写 IndexedDB，不受 5MB 限制。
   */
  MIRROR: ['holdings', 'watch', 'hideAmount', 'predictOn', 'logOn', 'themeMode'],

  _isMirror(k) { return this.MIRROR.indexOf(k) >= 0; },

  /** 启动时调用一次。**保证不抛异常**：失败就整体退回 localStorage。 */
  async open() {
    try {
      this.idb = await new Promise((res, rej) => {
        const rq = indexedDB.open(this.NAME, this.VER);
        rq.onupgradeneeded = () => {
          const d = rq.result;
          if (!d.objectStoreNames.contains(this.STORE)) d.createObjectStore(this.STORE);
        };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error || new Error('idb open failed'));
        rq.onblocked = () => rej(new Error('idb blocked'));
        setTimeout(() => rej(new Error('idb timeout')), 5000);
      });
      this.useIDB = true;

      const all = await this._readAll();
      if (all && Object.keys(all).length) {
        this.mem = all;
      } else {
        await this._migrateFromLS();
      }
      this.ready = true;
    } catch (e) {
      this.useIDB = false;
      this.idb = null;
      this._loadFromLS();
      this.ready = true;
      this.openError = (e && e.message) || String(e);
    }
  },

  /**
   * 把 localStorage 里已有的数据整体迁过来。
   * 只在 IndexedDB 为空时执行一次（靠 idb_meta 判定）。
   */
  async _migrateFromLS() {
    const pairs = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k);
        if (v == null) continue;
        pairs.push([k, v]);
      }
    } catch (e) { /* 读不到就当没有 */ }

    // 先写内存：即使后面落盘失败，本次运行也完全正常
    for (const [k, v] of pairs) this.mem[k] = v;

    if (!pairs.length) {
      this._putSync('idb_meta', JSON.stringify({ migratedAt: Date.now(), count: 0 }));
      return;
    }

    /*
     * 整批放进**一个事务**：要么全成、要么全不成。
     * 分多次写的话，中途失败会留下「迁了一半」的库 ——
     * 而下次启动看到库非空就不会再迁，那半份数据就成了永久的错误状态。
     */
    try {
      await new Promise((res, rej) => {
        const tx = this.idb.transaction(this.STORE, 'readwrite');
        const st = tx.objectStore(this.STORE);
        for (const [k, v] of pairs) st.put(v, k);
        st.put(JSON.stringify({ migratedAt: Date.now(), count: pairs.length, from: 'localStorage' }), 'idb_meta');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('tx aborted'));
      });
      this.mem['idb_meta'] = JSON.stringify({ migratedAt: Date.now(), count: pairs.length, from: 'localStorage' });
    } catch (e) {
      // 迁移失败：内存里已经有了，本次照常；下次启动会重试
      this.mem['idb_migrate_failed'] = String((e && e.message) || e);
    }
  },

  _readAll() {
    return new Promise((res, rej) => {
      try {
        const tx = this.idb.transaction(this.STORE, 'readonly');
        const st = tx.objectStore(this.STORE);
        const out = Object.create(null);
        const rq = st.openCursor();
        rq.onsuccess = () => {
          const c = rq.result;
          if (!c) { res(out); return; }
          out[c.key] = c.value;
          c.continue();
        };
        rq.onerror = () => rej(rq.error);
      } catch (e) { rej(e); }
    });
  },

  _putSync(key, val) {
    this.mem[key] = val;
    if (!this.idb) return;
    try {
      const tx = this.idb.transaction(this.STORE, 'readwrite');
      tx.objectStore(this.STORE).put(val, key);
    } catch (e) { /* ignore */ }
  },

  _loadFromLS() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k);
        if (v != null) this.mem[k] = v;
      }
    } catch (e) { /* ignore */ }
  },

  /** 同步读 —— 走内存，语义与 localStorage.getItem 完全一致 */
  get(key, dflt) {
    const v = this.mem[key];
    return (v === undefined || v === null) ? (dflt === undefined ? null : dflt) : v;
  },

  /**
   * 写：先落内存（立刻可见），再异步落盘。
   * 关键数据额外同步写一份 localStorage 兜底。
   */
  set(key, val) {
    const s = String(val == null ? '' : val);
    this.mem[key] = s;
    if (!this.ready || !this.useIDB || !this.idb) {
      try { localStorage.setItem(key, s); } catch (e) {}
      return;
    }
    if (this._isMirror(key)) {
      try { localStorage.setItem(key, s); } catch (e) {}
    }
    try {
      const tx = this.idb.transaction(this.STORE, 'readwrite');
      tx.objectStore(this.STORE).put(s, key);
      this.writeCount++;
    } catch (e) { /* 落盘失败不影响内存里的值 */ }
  },

  del(key) {
    delete this.mem[key];
    try { localStorage.removeItem(key); } catch (e) {}
    if (this.useIDB && this.idb) {
      try {
        const tx = this.idb.transaction(this.STORE, 'readwrite');
        tx.objectStore(this.STORE).delete(key);
      } catch (e) { /* ignore */ }
    }
  },

  /** 库容量概览（诊断页显示用） */
  stats() {
    let n = 0, bytes = 0;
    for (const k in this.mem) { n++; bytes += String(this.mem[k]).length + k.length; }
    return {
      n, bytes,
      engine: this.useIDB ? 'IndexedDB' : 'localStorage',
      writes: this.writeCount,
      migrated: this.mem['idb_meta'] || null,
      error: this.openError || null,
    };
  },
};

/**
 * 持仓变更流水。
 *
 * 为什么必须有它：
 *   以前 holdings 里只存**当前状态**（份额 + 成本），没有历史。
 *   于是「历史总资产涨跌」只能拿当前份额去乘历史净值 ——
 *   等于假设「这套组合你从一开始就持有」。
 *   用户明明是最近才买入的，却看到买入之前那段时间也在涨跌，
 *   数字自然是错的。
 *
 *   加了流水之后，每个日期能还原出「那天到底持有多少份额」，
 *   加仓 / 减仓 / 清仓都自然支持。
 *
 * 存法：每只基金一串快照 { d: 日期, s: 份额 }，按日期升序。
 * 只记「变更后的状态」而不是每笔交易，信息量足够且不易写错。
 */
const txLog = {
  KEY: 'txlog',
  data: null,
  MAX: 200,          // 每只基金最多留 200 个快照，够回溯好几年

  load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(db.get(this.KEY) || '{}') || {}; }
    catch (e) { this.data = {}; }
    return this.data;
  },

  save() {
    try { db.set(this.KEY, JSON.stringify(this.data || {})); } catch (e) { /* ignore */ }
  },

  list(code) { return this.load()[code] || []; },

  /**
   * 记一次份额快照。
   * 同一天重复调用只更新当天那条（用户可能反复改份额，不该留一堆）。
   */
  record(code, date, shares) {
    const d = this.load();
    if (!d[code]) d[code] = [];
    const arr = d[code];
    const s = +shares || 0;
    const last = arr[arr.length - 1];
    if (last && last.d === date) { last.s = s; }
    else if (!last || s !== last.s) { arr.push({ d: date, s: s }); }
    if (arr.length > this.MAX) arr.splice(0, arr.length - this.MAX);
    this.save();
  },

  /**
   * 某只基金在指定日期的份额。
   *
   * - 那天还没记录 → 0（还没买入）
   * - 记录之间有空洞 → 取之前最近一次的值（份额不变就是持有中）
   */
  sharesAt(code, date) {
    const arr = this.list(code);
    if (!arr.length) return null;      // null = 没有流水，交给调用方兜底
    let s = 0;
    for (const it of arr) {
      if (it.d <= date) s = it.s; else break;
    }
    return s;
  },

  /** 这只基金有流水吗 */
  has(code) { return this.list(code).length > 0; },

  /** 该基金最早的快照日期 */
  firstDate(code) {
    const arr = this.list(code);
    return arr.length ? arr[0].d : null;
  },
};

/**
 * 给还没有流水的持仓补一条基线快照。
 *
 * 老用户升级上来时 txlog 是空的，必须补一条，否则历史收益会退化成
 * 「假设他一直持有这套组合」—— 那正是这次要修的那个 bug。
 *
 * 基线日期优先用：用户填的买入日 → 加入日期 → 按成本价在净值上反推。
 * 三个都拿不到（净值还没加载完）就先跳过，等下一轮再补，
 * 绝不拿「今天」硬凑：那会把真实持有期算短，同样是错的。
 */
function ensureTxBaseline() {
  let n = 0;
  for (const h of S.holdings) {
    if (txLog.has(h.code)) continue;
    const d = h.buyDate || h.addedAt || inferStartDate(h, S.full[h.code]);
    if (!d) continue;
    txLog.record(h.code, d, +h.shares || 0);
    n++;
  }
  return n;
}

/* ---------------- 存储 ---------------- */
const store = {
  load() {
    try {
      S.holdings = JSON.parse(db.get('holdings') || '[]');
      S.watch = JSON.parse(db.get('watch') || '[]');
      S.hideAmount = db.get('hideAmount') === '1';
      S.predictOn = db.get('predictOn') !== '0';
      S.logOn = db.get('logOn') !== '0';   // 默认开
    } catch (e) { S.holdings = []; S.watch = []; }
    store.sanitize();
  },

  /**
   * 清洗脏数据。
   *
   * 表单会挡住手输的负份额，但截图 OCR、导入的 JSON、
   * 以及更早版本写进 localStorage 的记录都可能带负值进来，
   * 渲染出来就是「¥-399.63」「-485.75%」这种一眼就错的数。
   * 份额和成本价都不允许为负，非法值一律归零。
   */
  sanitize() {
    const num = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0;
    S.holdings = (Array.isArray(S.holdings) ? S.holdings : [])
      .filter(h => h && h.code)
      .map(h => Object.assign({}, h, {
        shares: num(+h.shares),
        costNav: num(+h.costNav),
      }));
    S.watch = (Array.isArray(S.watch) ? S.watch : []).filter(w => w && w.code);
  },
  save() {
    db.set('holdings', JSON.stringify(S.holdings));
    db.set('watch', JSON.stringify(S.watch));
    db.set('hideAmount', S.hideAmount ? '1' : '0');
    db.set('predictOn', S.predictOn ? '1' : '0');
    db.set('logOn', S.logOn ? '1' : '0');
  },
};

/**
 * 显示 / 隐藏金额的图标。
 *
 * 原来嵌的是 🙈 / 👁 两个 emoji —— 各系统字形不一、还自带颜色，
 * 跟整套单色线性图标完全不搭。换成一对线性图标，
 * 由 CSS 依据 body.hideamt 交叉切换（见样式表里的 .ac-eye）。
 */
const EYE_ICONS = '<svg class="eye-open" viewBox="0 0 24 24">'
  + '<path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z"/>'
  + '<circle cx="12" cy="12" r="3.1"/></svg>'
  + '<svg class="eye-off" viewBox="0 0 24 24">'
  + '<path d="M3.4 11.4S6.8 6.6 12 6.6s8.6 4.8 8.6 4.8"/>'
  + '<path d="M3.8 15.6l2.3-2M9.4 17l.9-2.4M14.6 17l-.9-2.4M20.2 15.6l-2.3-2"/></svg>';

/* ---------------- 工具 ---------------- */
const fmt = (n, d = 2) => (isFinite(n) ? n.toFixed(d) : '--');
const pctCls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const pctTxt = v => (v == null || !isFinite(v)) ? '--'
  : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const moneyTxt = v => (v == null || !isFinite(v)) ? '--'
  : (v > 0 ? '+' : '') + v.toFixed(2);

/**
 * 带千分位的金额。
 *
 * 总资产动辄五六位数，不加分隔符「25280.40」很难一眼读出量级。
 * toLocaleString 在 WebView 上原生支持，不用自己写正则。
 */
const moneyFull0 = v => (v == null || !isFinite(v)) ? '--'
  : v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 同上，但带正负号（涨跌额用） */
const moneyFull = v => (v == null || !isFinite(v)) ? '--'
  : (v > 0 ? '+' : (v < 0 ? '-' : '')) + moneyFull0(Math.abs(v));

/**
 * 统一的时间来源。
 *
 * 手机时钟被动过、时区设错时，直接读 Date.now() 会让
 * 「更新于 14:30」这类标签全是错的。原生侧启动时用 HTTP 响应头
 * 校准过一次，这里优先走它，拿不到再退回本地时间。
 */
function nowMs() {
  try {
    if (window.Native && Native.now) return Native.now();
  } catch (e) { /* 浏览器预览没有桥 */ }
  return Date.now();
}

/** 当前时间 HH:MM */
function nowHHMM() {
  const d = new Date(nowMs());
  const p2 = n => String(n).padStart(2, '0');
  return p2(d.getHours()) + ':' + p2(d.getMinutes());
}

/**
 * 本地时间 HH:MM:SS。
 *
 * 日志时间戳一律走这里，**不要用 toISOString()**：
 * 那个返回的是 UTC，在东八区会整整少 8 小时 ——
 * 调试日志页上显示 14:58、实际却是 22:58，
 * 和同一条对时日志里的本地时间对不上，排查时极其误导。
 * （本文件 3968 行那个「+8 小时」就是被同一个坑咬过一次。）
 */
function hhmmss() {
  const d = new Date(nowMs());
  const p2 = n => String(n).padStart(2, '0');
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

/** 当前时间 YYYY-MM-DD */
function todayStr() {
  const d = new Date(nowMs());
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1700);
}

/** 两个 YYYY-MM-DD 之间差几天（今天是 0） */
function dayGap(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  const now = new Date(nowMs());
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t0 - d) / 86400000);
}

/**
 * 判断基金类型。
 *
 * 类型决定了「净值怎么更新才是正常的」：
 *   货币基金单位净值恒为 1，只看万份收益，用涨跌幅算收益是错的
 *   QDII 投海外，净值天然滞后一两天，不能当成数据没更新
 *   债券型波动小，涨跌幅经常接近 0
 *   指数型跟随标的指数，盘中有实时估值参考
 *
 * 先看名字，名字判断不出来再看净值特征，两者都不像就归为混合型。
 */
function fundType(name, trend) {
  const n = name || '';

  // 货币基金：名字带货币，或单位净值长期恒为 1
  if (/货币|理财|现金管理|宝\b/.test(n)) return 'money';
  if (trend && trend.length > 20) {
    const tail = trend.slice(-20);
    if (tail.every(x => Math.abs(x.nav - 1) < 1e-9)) return 'money';
  }

  if (/QDII|全球|海外|纳斯达克|标普|道琼斯|恒生|港股|美国|欧洲|日本|亚太|新兴市场|中概|德国|法国|印度|越南|黄金|原油/i.test(n)) return 'qdii';
  if (/债|固收|短融|利率|信用/.test(n)) return 'bond';
  if (/指数|ETF|联接|LOF/.test(n)) return 'index';
  if (/股票/.test(n)) return 'stock';
  return 'mix';
}

const FUND_TYPE_NAME = {
  money: '货币', qdii: 'QDII', bond: '债券',
  index: '指数', stock: '股票', mix: '混合',
};

/**
 * 计算一只持仓的真实盈亏，把分红算进去。
 *
 * 两种分红方式结果完全不同，必须分开算：
 *
 *   现金分红(cash)
 *     份额不变，钱打到余额里。所以市值看不出这笔钱，
 *     真实收益 = 市值 - 本金 + 已收到的现金分红。
 *     只按净值算会把分红当成亏损，这是最常见的错账。
 *
 *   红利再投(reinvest)
 *     分红自动买成份额，份额已经变大，
 *     市值里就含了分红，直接 市值 - 本金 即可，不能重复加。
 *
 * buyDate 用来圈定「我买入之后」的分红。没填就从成本净值反推
 * 一个大概的买入日：在历史净值里找第一次接近成本净值的那天。
 */
function holdCalc(h, full) {
  const nav = S.nav[h.code] || null;
  // 用盘中现价而不是最新已公布净值，资产才会随当天涨跌实时变化：
  // 收盘前是「昨净值 × (1+预估)」，收盘后自动变成当日真实净值。
  const pair = navPairOf(h.code);
  const cur = pair ? pair.curNav : (nav ? nav.nav : h.costNav);
  // 最后一道防线：份额/成本不允许为负。store.sanitize() 已在读入时
  // 清洗过，这里再兜一次，保证任何调用路径都不会算出负市值。
  const shares = Math.max(0, +h.shares || 0);
  const costNav = Math.max(0, +h.costNav || 0);

  const value = cur * shares;
  const principal = costNav * shares;
  const divMode = h.divMode === 'reinvest' ? 'reinvest' : 'cash';

  // 找出买入日之后的分红
  let sinceDate = h.buyDate || null;
  if (!sinceDate && full && full.trend && full.trend.length) {
    // 反推：从后往前找第一个单位净值不高于成本价的日子
    for (let k = full.trend.length - 1; k >= 0; k--) {
      if (full.trend[k].nav <= costNav) { sinceDate = full.trend[k].date; break; }
    }
  }

  let cashDiv = 0, divCount = 0, divList = [];
  if (full && full.divs && full.divs.length) {
    for (const d of full.divs) {
      if (sinceDate && d.date < sinceDate) continue;
      if (d.kind === 'div') {
        divCount += 1;
        divList.push(d);
        // 现金分红：每份派多少钱 × 份额
        if (divMode === 'cash') cashDiv += d.per * shares;
      }
    }
  }

  const profit = value - principal + cashDiv;
  const profitPct = principal ? profit / principal * 100 : 0;

  return {
    nav: cur,
    shares,
    costNav,
    value,
    principal,
    divMode,
    cashDiv,
    divCount,
    divList,
    sinceDate,
    profit,
    profitPct,
    type: full ? full.type : 'mix',
    lagDays: full ? full.lagDays : null,
    latestDate: full && full.latest ? full.latest.date : (nav ? nav.date : null),
  };
}

/**
 * 基金名 -> 跟踪指数。
 *
 * 指数基金的名字里几乎都写着标的指数，直接按关键词认。
 * 顺序有讲究：越具体的往前放，否则「中证500增强」会先命中「中证500」
 * 还行，但「创业板50」会被「创业板」抢走，所以长的排前面。
 *
 * 债券基金也要指到债券指数上——债基和股票指数毫无关联，
 * 拿沪深300去预测债基必然离谱。
 */
const INDEX_MAP = [
  // 债券类（先判债，债基名字里也可能出现别的板块词）
  { re: /可转债|转债/, code: 'sh000832', name: '中证转债' },
  { re: /国债|利率债|政金债/, code: 'sh000012', name: '国债指数' },
  { re: /信用债|企债|公司债/, code: 'sh000013', name: '企债指数' },
  // 认不出具体品种的债基，统一拿国债指数当参照：
  // 纯债日波动只有万分之几，能对上大致方向就够了
  { re: /债/, code: 'sh000012', name: '国债指数' },

  // 宽基
  { re: /科创100/, code: 'sh000698', name: '科创100' },
  { re: /科创50|科创板50/, code: 'sh000688', name: '科创50' },
  { re: /创业板50/, code: 'sz399673', name: '创业板50' },
  { re: /创业板/, code: 'sz399006', name: '创业板指' },
  { re: /中证1000/, code: 'sh000852', name: '中证1000' },
  { re: /中证500/, code: 'sh000905', name: '中证500' },
  { re: /上证50/, code: 'sh000016', name: '上证50' },
  { re: /上证180/, code: 'sh000010', name: '上证180' },
  { re: /沪深300/, code: 'sh000300', name: '沪深300' },
  { re: /深证100/, code: 'sz399330', name: '深证100' },
  { re: /深证成指|深成指/, code: 'sz399001', name: '深证成指' },
  { re: /上证指数|上证综指/, code: 'sh000001', name: '上证指数' },
  { re: /中证100\b/, code: 'sh000903', name: '中证100' },

  // 红利 / 价值
  { re: /红利低波/, code: 'sh000922', name: '中证红利' },
  { re: /红利/, code: 'sh000922', name: '中证红利' },

  // 行业主题
  { re: /白酒|食品饮料/, code: 'sz399997', name: '中证白酒' },
  { re: /医疗/, code: 'sz399989', name: '中证医疗' },
  { re: /医药|生物医药|创新药/, code: 'sh000991', name: '全指医药' },
  { re: /军工|国防/, code: 'sz399967', name: '中证军工' },
  { re: /银行/, code: 'sz399986', name: '中证银行' },
  { re: /证券|券商|非银/, code: 'sz399975', name: '证券公司' },
  { re: /煤炭/, code: 'sz399998', name: '中证煤炭' },
  { re: /传媒|游戏|影视/, code: 'sz399971', name: '中证传媒' },
  { re: /新能源车|新能车|电动车/, code: 'sz399417', name: '新能源车' },
  { re: /环保|碳中和/, code: 'sh000827', name: '中证环保' },
  { re: /半导体|芯片/, code: 'sh000688', name: '科创50' },
  { re: /电子|消费电子/, code: 'sh000993', name: '全指信息' },
  { re: /计算机|软件|信息技术/, code: 'sh000993', name: '全指信息' },
  { re: /通信|5G/, code: 'sh000993', name: '全指信息' },
  { re: /消费/, code: 'sh000932', name: '主要消费' },
  { re: /地产|房地产/, code: 'sz399393', name: '国证地产' },
  { re: /有色|稀土/, code: 'sh000819', name: '有色金属' },

  // 港股 / 海外
  { re: /恒生科技|港股科技/, code: 'hkHSTECH', name: '恒生科技' },
  { re: /恒生国企|H股|国企指数/, code: 'hkHSCEI', name: '国企指数' },
  { re: /恒生|港股/, code: 'hkHSI', name: '恒生指数' },
  { re: /纳斯达克100|纳指100|纳指/, code: 'usNDX', name: '纳斯达克100' },
  { re: /标普500|标普/, code: 'usINX', name: '标普500' },
  { re: /道琼斯/, code: 'usDJI', name: '道琼斯' },
];

/**
 * 从「报告期」推算「发布日」。
 *
 * 这两个是完全不同的日期，混起来会得出相反的结论：
 *
 *   报告期   数据截止的那天（6/30）
 *   发布日   公告真正挂出来的那天（7/20 前后）
 *
 * 法规要求季报在季度结束后 15 个工作日内披露，折成自然日约 +21 天；
 * 年报要审计，法定可以拖到次年 3/31，实际多在 3 月下旬。
 *
 * 举个反例：今天 7 月 10 日，手上报告期是 6/30。
 *   按报告期算「才过 10 天，很新」—— 但这份报告**根本还没发布**，
 *   我们真正拿到的是 3/31 那一期，已经过期三个半月。
 *   这个窗口期恰恰是估算最不靠谱的时候，旧逻辑却给了它满分。
 */
function reportPublishDate(report) {
  const m = String(report || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const pad = n => String(n).padStart(2, '0');

  // 年报：审计流程长，法定截止次年 3/31
  if (mo === 12) return (y + 1) + '-03-28';

  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + 21);
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
}

/**
 * 季报持仓的新鲜度（0.25 ~ 1）。
 *
 * 判断依据是**发布日**，不是报告期（理由见 reportPublishDate）。
 *
 *   还没发布        0.25  手上是上一期的，比真实持仓落后一整个季度
 *   发布后 0~25 天   1.0   **最准的时候**：刚披露，基金还没来得及大动
 *   之后             线性衰减，到下一份发布前压到 0.4
 *
 * 这只是先验；真正的判断交给误差账本 ——
 * 持仓要是真变了，预测误差会立刻抬起来，权重会被进一步压低。
 */
function holdingsFreshness(report) {
  const pub = reportPublishDate(report);
  if (!pub) return 0.5;

  const sincePub = dayGap(pub);   // 正数 = 已发布；负数 = 还没到发布日
  if (sincePub == null) return 0.5;
  if (sincePub < 0) return 0.25;
  if (sincePub <= 25) return 1;
  return Math.max(0.4, 1 - (sincePub - 25) / 140 * 0.6);
}

/**
 * K 线请求闸门。
 *
 * 腾讯的 K 线接口对突发并发很敏感：26 只股票同时拉，直接回 501。
 * 这里限制同时最多 2 个在飞，其余排队，间隔 120ms。
 *
 * 实测加上闸门后 501 消失，总耗时反而更快——
 * 因为不用再为重试浪费 1 秒多。
 */
const klineGate = {
  running: 0,
  LIMIT: 2,
  GAP: 120,
  queue: [],

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.pump();
    });
  },

  pump() {
    if (this.running >= this.LIMIT || !this.queue.length) return;
    const job = this.queue.shift();
    this.running += 1;
    Promise.resolve()
      .then(() => job.fn())
      .then(v => job.resolve(v))
      .catch(e => job.reject(e))
      .finally(() => {
        setTimeout(() => {
          this.running -= 1;
          this.pump();
        }, this.GAP);
      });
  },
};

/** 股票代码 -> 腾讯行情代码（sh/sz/bj + 6 位） */
function toTxCode(c) {
  if (!/^\d{6}$/.test(c || '')) return null;
  return (/^[69]/.test(c) ? 'sh' : (/^[48]/.test(c) ? 'bj' : 'sz')) + c;
}
/**
 * 板块 / 指数名的关键词表，用于把它和新闻标题对上。
 *
 * 用户的原话是「加对应导致这个指数会这样的新闻」——
 * 也就是要能回答「它今天为什么涨跌」。
 * 做法是把板块名及其常见叫法拿去匹配资讯标题：
 * 媒体写「白酒」还是「中证白酒」都能命中。
 */
const MOOD_ALIAS = {
  '电子': ['电子', '半导体', '芯片', '消费电子', 'PCB'],
  '半导体': ['半导体', '芯片', '晶圆', '光刻', '存储'],
  '计算机': ['计算机', '软件', '信创', '人工智能', 'AI', '算力'],
  '通信': ['通信', '5G', '光模块', 'CPO', '运营商'],
  'CPO通信': ['CPO', '光模块', '光通信', '算力'],
  '传媒': ['传媒', '游戏', '影视', '短剧', '出版'],
  '银行': ['银行', '存款', '息差', '信贷'],
  '非银金融': ['券商', '证券', '保险', '非银'],
  '证券': ['券商', '证券', '两融', '成交额'],
  '房地产': ['房地产', '地产', '楼市', '房贷', '保交楼'],
  '食品饮料': ['食品', '饮料', '白酒', '啤酒', '乳业'],
  '白酒': ['白酒', '茅台', '五粮液', '酒企'],
  '医药生物': ['医药', '生物', '创新药', '医疗', '集采', 'CXO'],
  '医药': ['医药', '创新药', '集采', '医保'],
  '医疗': ['医疗', '器械', '医院', 'CRO'],
  '电力设备': ['电力设备', '光伏', '风电', '储能', '锂电'],
  '机械设备': ['机械', '工程机械', '机床', '机器人'],
  '机器人': ['机器人', '人形机器人', '减速器', '灵巧手'],
  '汽车': ['汽车', '新能源车', '车企', '智能驾驶', '整车'],
  '有色金属': ['有色', '铜', '铝', '锂', '稀土', '黄金'],
  '稀土': ['稀土', '永磁', '镨钕'],
  '黄金': ['黄金', '金价', '避险', '金矿'],
  '煤炭': ['煤炭', '焦煤', '动力煤', '煤价'],
  '石油石化': ['石油', '石化', '原油', '油价', '炼化'],
  '基础化工': ['化工', '化纤', '农药', '磷矿'],
  '钢铁': ['钢铁', '钢材', '螺纹钢', '铁矿'],
  '建筑装饰': ['建筑', '基建', '工程', '中标'],
  '建筑材料': ['建材', '水泥', '玻璃', '防水'],
  '轻工制造': ['轻工', '造纸', '包装', '家居'],
  '家用电器': ['家电', '空调', '白电', '厨电'],
  '纺织服饰': ['纺织', '服装', '服饰', '鞋帽'],
  '商贸零售': ['零售', '商贸', '超市', '免税', '电商'],
  '社会服务': ['社服', '旅游', '酒店', '餐饮', '免税'],
  '农林牧渔': ['农业', '养殖', '猪', '饲料', '种业'],
  '养猪': ['生猪', '猪价', '养殖', '能繁母猪'],
  '公用事业': ['公用事业', '电力', '水电', '燃气', '核电'],
  '交通运输': ['交运', '航运', '航空', '港口', '物流'],
  '国防军工': ['军工', '国防', '航空发动机', '导弹', '军贸'],
  '煤炭开采': ['煤炭', '煤价', '焦煤'],
  '环保': ['环保', '碳中和', '污水', '固废'],
  '美容护理': ['美容', '化妆品', '医美', '个护'],
  '综合': ['综合'],
  '科创50': ['科创板', '科创50', '硬科技'],
  '创业板': ['创业板', '成长股'],
  '沪深300': ['沪深300', '大盘蓝筹', '权重股'],
  '中证500': ['中证500', '中盘'],
  '中证1000': ['中证1000', '小盘股'],
  '银行ETF': ['银行'],
  '电网设备': ['电网', '特高压', '变压器', '智能电网'],
  'PCB': ['PCB', '覆铜板', '印制电路'],
  'CPO': ['CPO', '光模块', '共封装'],
  'CRO': ['CRO', 'CXO', '临床', '药明'],
  '红利': ['红利', '高股息', '分红'],
  '中证1000ETF华泰柏瑞': ['中证1000', '小盘'],
};

/**
 * 找某个板块相关的新闻。
 *
 * 只用标题匹配，不碰正文——正文要联网抓，为了显示一个角标
 * 去抓几十篇正文不值得。标题命中已经足够回答「发生了什么」，
 * 想看细节点进去即可。
 */
function newsFor(name, limit) {
  if (!name || !S.news || !S.news.length) return [];
  const words = MOOD_ALIAS[name] || [name];
  const hit = [];
  for (const n of S.news) {
    const t = n.title || '';
    for (const w of words) {
      if (w && t.indexOf(w) >= 0) { hit.push(n); break; }
    }
    if (hit.length >= (limit || 6)) break;
  }
  return hit;
}

/** 相关异动区块：折叠展示，点标题进正文 */
function newsBlock(name, limit) {
  const list = newsFor(name, limit || 4);
  if (!list.length) return '';

  let html = '<div class="evbox">'
    + '<div class="evhead"><span class="evdot"></span>相关异动 '
    + '<b>' + list.length + '</b> 条</div>';

  for (const n of list) {
    html += '<div class="evitem"'
      + ' data-article="' + encodeURIComponent(n.url || '') + '"'
      + ' data-title="' + encodeURIComponent(n.title || '') + '">'
      + '<span class="evtxt">' + (n.title || '') + '</span>'
      + '<span class="evmeta">' + (n.media || '') + ' ' + (n.time || '') + '</span>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

/** 从基金名解析跟踪指数，认不出来返回 null */
function indexOf(name) {
  if (!name) return null;
  for (const x of INDEX_MAP) {
    if (x.re.test(name)) return { code: x.code, name: x.name };
  }
  return null;
}

/**
 * 最小二乘回归：用指数涨跌 R 解释基金涨跌 Y。
 *
 *   β = Σ(R·Y) / Σ(R²)
 *
 * β 就是「指数涨 1%，这只基金净值涨多少」。
 * 增强型、费率、现金仓位、跟踪误差都会体现在 β 上，
 * 所以不需要再去猜它到底持仓比例多少。
 *
 * 同时算 R²：太低说明这只基金根本不跟这个指数，
 * 宁可退回别的方法，也不要硬套一个错的指数。
 */
function regressBeta(pairs) {
  let srr = 0, sry = 0, syy = 0, n = 0;
  for (const p of pairs) {
    if (!isFinite(p.r) || !isFinite(p.y)) continue;
    srr += p.r * p.r;
    sry += p.r * p.y;
    syy += p.y * p.y;
    n += 1;
  }
  if (n < 8 || srr < 1e-9) return null;
  const beta = sry / srr;
  if (!isFinite(beta)) return null;
  const r2 = (sry * sry) / (srr * syy || 1);
  return { beta: Math.max(0.1, Math.min(3, beta)), r2, n };
}

/**
 * 我的组合估值水平。
 *
 * 把每只持仓对到它跟踪指数的 PE，按持有市值加权。
 *
 * 用途很实在：单看某只基金贵不贵意义不大，
 * 但如果整个组合的 PE 分位在历史的 90% 以上，
 * 那就是「我买的东西整体很贵」——这是减仓信号，而不是继续加。
 *
 * 匹配不上的基金直接跳过，不做任何估算，
 * 因为用错指数算出来的估值比没有更害人。
 */
function portfolioValuation() {
  if (!S.idxVal) return null;

  let wsum = 0, peSum = 0, pctSum = 0, pctW = 0, matched = 0;

  for (const h of S.holdings) {
    const c = holdCalc(h, S.full[h.code]);
    const idx = indexOf(h.name);
    if (!idx) continue;
    const rec = valuationByCode(idx.code);
    if (!rec || rec.pe == null || !(rec.pe > 0)) continue;

    const w = c.value || 0;
    wsum += w;
    peSum += rec.pe * w;
    if (rec.pePct != null) { pctSum += rec.pePct * w; pctW += w; }
    matched += 1;
  }

  if (!wsum || !matched) return null;
  return {
    pe: peSum / wsum,
    pct: pctW ? pctSum / pctW : null,
    matched,
    total: S.holdings.length,
  };
}

/**
 * 把 lsjz 的净值合并进全量历史。
 *
 * pingzhongdata 更新稍慢，两个源日期对不上时以 lsjz 为准（它更及时），
 * 把缺的那几天补进去并按日期排序去重。
 */
function mergeNavIntoFull(code, list) {
  const full = S.full[code];
  if (!full || !full.trend || !full.trend.length) return;

  const byDate = Object.create(null);
  for (const t of full.trend) byDate[t.date] = t;

  let added = 0;
  for (const n of list) {
    if (!n || !n.date || !isFinite(n.nav)) continue;
    const old = byDate[n.date];
    if (old) {
      if (old.nav !== n.nav) { old.nav = n.nav; added += 1; }
      if (isFinite(n.pct)) old.pct = n.pct;
    } else {
      full.trend.push({
        ts: new Date(n.date + 'T00:00:00').getTime(),
        date: n.date, nav: n.nav, acw: n.nav,
        pct: isFinite(n.pct) ? n.pct : null,
      });
      added += 1;
    }
  }
  if (!added) return;

  full.trend.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = full.trend[full.trend.length - 1];
  if (last) { full.latest = last; full.lagDays = dayGap(last.date); }
}

/** 当前价格：优先实时估值，其次最新净值，最后成本 */
function priceOf(code, fallback) {
  const g = S.gz[code];
  if (g && g.gsz) return g.gsz;
  const q = S.nav[code];
  if (q) {
    // 拿不到官方实时估值时（QDII 基本都没有），用预测涨跌推算盘中净值，
    // 比直接拿昨日净值当现价更接近真实持仓市值。
    const pr = S.predict[code];
    if (S.predictOn && pr && isFinite(pr.est)) return q.nav * (1 + pr.est / 100);
    return q.nav;
  }
  return fallback || 0;
}

/**
 * 取一只基金的「现价 / 上一交易日净值」这一对基准。
 *
 * 当日盈亏必须用同一套口径算，否则总资产涨跌和单只基金涨跌对不上：
 *
 *   今日净值已公布(收盘后)
 *     涨跌 = 今日净值 vs 上一交易日净值，这是已实现的真实收益；
 *   盘中(今日净值还没出)
 *     涨跌 = 现价 vs 最新已公布净值，最新净值就是上一交易日的。
 *
 * 后者在有实时估值时用估值，没有时用预估值推算，再没有就退回昨净值，
 * 此时当日盈亏为 0——宁可显示 0，也不要拿一个错基准算出一个错的收益。
 */
function navPairOf(code) {
  const q = S.nav[code];
  if (!q) return null;

  const full = S.full[code];
  const trend = full && full.trend && full.trend.length ? full.trend : null;
  const today = todayStr();

  if (q.date === today) {
    // 今日净值已出：真实涨跌 = 今日 vs 上一交易日
    let prevNav = q.nav;
    if (trend) {
      for (let k = trend.length - 1; k > 0; k--) {
        if (trend[k].date === q.date) { prevNav = trend[k - 1].nav; break; }
      }
    }
    return { curNav: q.nav, prevNav, date: q.date, realized: true };
  }

  // 盘中：现价 vs 最新已公布净值
  const curNav = priceOf(code, q.nav);
  // 既没官方估值也没预估时，curNav 就等于昨净值。
  // 这时「涨跌 0」是没数据，不是真的没涨，要区分开。
  const g = S.gz[code];
  const hasLive = !!(g && g.gsz)
    || !!(S.predictOn && S.predict[code] && isFinite(S.predict[code].est));
  return { curNav, prevNav: q.nav, date: q.date, realized: false, live: hasLive };
}

/**
 * 当日涨跌幅（%）。
 *
 * 统一从 navPairOf 推导，不再直接读基金公司的估值涨跌幅——
 * 那个口径和「现价/昨净值」不一定一致，混用会导致合计对不上。
 */
function todayPctOf(code) {
  const pr = navPairOf(code);
  if (!pr || !pr.prevNav) return null;
  // 盘中且没有实时数据：返回 null 让界面显示 --，不要假装涨跌为 0
  if (!pr.realized && pr.live === false) return null;
  return (pr.curNav / pr.prevNav - 1) * 100;
}


/* ---------------- 调试日志 ----------------
 *
 * 目的：出问题时能远程看到现场，不需要拿手机、不需要连电脑。
 *
 * 三条出口：
 *   1. 内存环形缓冲（最多 400 条）—— App 内「我的 → 调试日志」直接看
 *   2. logcat —— adb logcat 就能拉，远程排查最常用
 *   3. localStorage —— 崩溃后重启还能看到上次的记录
 *
 * 刻意做了「最小」：只记关键节点，不记每次渲染，
 * 否则日志本身就成了性能负担。
 * ---------------- */
const diag = {
  MAX: 400,
  buf: [],

  load() {
    if (this.buf.length) return;
    try {
      const v = JSON.parse(db.get("diaglog") || "[]");
      if (Array.isArray(v)) this.buf = v.slice(-this.MAX);
    } catch (e) { /* ignore */ }
  },

  save() {
    // 只在页面隐藏或出错时落盘，避免频繁写
    try {
      db.set("diaglog", JSON.stringify(this.buf.slice(-120)));
    } catch (e) { /* 空间不够就算了 */ }
  },

  _push(level, msg, extra) {
    // 总开关关着就直接丢弃：日常使用不需要日志，
    // 开着只会白白占内存、拖慢主线程
    if (!S.logOn) return;

    const rec = {
      t: hhmmss(),   // 本地时间；toISOString 是 UTC，会差 8 小时
      lv: level,
      m: String(msg).slice(0, 300),
    };
    if (extra != null) {
      try { rec.x = String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300); }
      catch (e) { /* ignore */ }
    }
    this.buf.push(rec);
    if (this.buf.length > this.MAX) this.buf.shift();

    /*
     * 推 logcat 的策略：
     *   警告/错误  必推（这是排查的重点）
     *   关键事件   必推（启动、切页、刷新开始/结束）
     *   其他普通信息 只留内存，避免刷屏拖慢
     */
    const key = level !== "I"
      || /启动|切换页面|自检|校准|失败|异常|性能|掉帧|监控|净值/.test(rec.m);
    if (key) {
      /*
       * 带上到秒的时间戳。
       *
       * 原来只推「级别 + 内容」，文件里一大半行没有时间；
       * 而仅有的那几条 T 行（对时）走的是另一条直写通道，
       * 于是同一次启动的日志在文件里前后交错、还看不出先后 ——
       * 实测出现过「性能监控已启动」排在「22:58 时间已同步」后面。
       * rec.t 里本来就有时间，直接用。
       */
      this._queue(rec.t + " " + level + " " + rec.m + (rec.x ? " | " + rec.x : ""));
    }

    /*
     * 不在这里调 console.log。
     *
     * Android WebView 的 console 消息要跨进程转发给原生，
     * 单次大约几百毫秒。批量请求时每条都打一次，
     * 主线程直接被堵死——实测启动阶段掉到 0.3 fps。
     *
     * 内存缓冲是同步且极快的，日志照记不误；
     * 需要看 logcat 时，手动在诊断页点「输出到 logcat」即可。
     */
  },

  /* ---- 实时上传：批量推 logcat ---- */
  _out: [],
  _timer: null,

  /**
   * 把日志推到 logcat（adb 可实时抓）。
   *
   * 不能每条都推：WebView 的跨进程调用单次几百毫秒，
   * 请求多的时候会把主线程堵死（实测掉到 0.3fps）。
   * 这里先攒着，250ms 合并成一次调用。
   */
  _flush() {
    this._timer = null;
    if (!this._out.length) return;
    const batch = this._out.splice(0, 40);
    try {
      /*
       * 必须序列化成字符串。
       * @JavascriptInterface 的方法参数类型是强匹配的：
       * 传数组给 String 参数会静默失败，日志就全丢了。
       */
      if (window.Native) {
        const payload = JSON.stringify(batch);
        // 双通道：logcat + 文件。哪条通就用哪条
        if (typeof Native.logBatch === "function") {
          try { Native.logBatch(payload); } catch (e) {}
        }
        if (typeof Native.writeLogText === "function") {
          try { Native.writeLogText(batch.join(String.fromCharCode(10))); } catch (e) {}
        }
      }
    } catch (e) { /* 无桥就丢弃 */ }
  },

  _queue(line) {
    this._out.push(line);
    if (this._out.length > 200) this._out.shift();
    if (!this._timer) {
      this._timer = setTimeout(() => this._flush(), 250);
    }
  },

  info(msg, extra) { this._push("I", msg, extra); },
  warn(msg, extra) { this._push("W", msg, extra); },
  error(msg, extra) { this._push("E", msg, extra); this.save(); },

  clear() {
    this.buf = [];
    try { db.del("diaglog"); } catch (e) {}
  },

  /** 导出成纯文本，方便复制发给别人 */
  dump() {
    return this.buf.map(r =>
      r.t + " " + r.lv + " " + r.m + (r.x ? " | " + r.x : "")
    ).join("\n");
  },
};

diag.load();

/* 全局错误必须被记录：白屏、点不动这类问题，往往就藏在这 */
window.addEventListener("error", e => {
  diag.error("JS 错误: " + (e.message || ""), (e.filename || "") + ":" + (e.lineno || ""));
});
window.addEventListener("unhandledrejection", e => {
  const r = e.reason;
  diag.error("未处理异常: " + ((r && r.message) || r || ""));
});

/** 包一层：记录接口调用结果与耗时，失败时保留原因 */
async function traced(name, fn) {
  const t0 = Date.now();
  try {
    const v = await fn();
    const ms = Date.now() - t0;
    if (ms > 4000) diag.warn(name + " 慢 " + ms + "ms");
    return v;
  } catch (e) {
    diag.error(name + " 失败", (e && e.message) || String(e));
    throw e;
  }
}

/**
 * 网络调用追踪。
 *
 * 所有 httpOnce 都从这里过，记录：接口名、耗时、状态、失败原因。
 * 这是排查「数据出不来」最直接的一手材料——
 * 到底是 DNS 失败、超时、还是返回了空内容，一眼能看出来。
 */
const netTrace = {
  list: [],
  MAX: 120,

  push(rec) {
    this.list.push(rec);
    if (this.list.length > this.MAX) this.list.shift();
  },

  /** 从 URL 里提取一个短名字，日志里好认 */
  short(url) {
    const m = String(url).match(/^https?:\/\/([^\/]+)(\/[^?]*)?/);
    if (!m) return String(url).slice(0, 40);
    return m[1].replace(/^www\./, "") + (m[2] || "").slice(0, 28);
  },

  fail() { return this.list.filter(r => !r.ok); },
}

/**
 * 带追踪的 HTTP 请求。
 *
 * 原 httpGet 不变，这里只加一层观测，出错时把原因完整记下来。
 */
async function tracedGet(url, gbk, opt) {
  const t0 = Date.now();
  const name = netTrace.short(url);
  try {
    const v = await httpGet(url, gbk, opt);
    const ms = Date.now() - t0;
    netTrace.push({ t: nowHHMM(), name, ms, ok: true, len: String(v || "").length });
    if (ms > 5000) diag.warn("慢请求 " + name, ms + "ms");
    return v;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = (e && e.message) || String(e);
    netTrace.push({ t: nowHHMM(), name, ms, ok: false, err: msg });
    diag.error("请求失败 " + name, msg + " · " + ms + "ms");
    throw e;
  }
}

/** 桥能力探测：直接把 window.Native 上挂了哪些方法列出来 */
function nativeProbe() {
  if (!window.Native) return "无原生桥";
  const want = ["httpGet", "log", "logBatch", "updateCanGoBack",
    "setTheme", "openReader", "toast", "now"];
  const has = [], miss = [];
  for (const k of want) {
    try {
      if (typeof Native[k] === "function") has.push(k); else miss.push(k);
    } catch (e) { miss.push(k); }
  }
  return has.length + "/" + want.length + " 可用"
    + (miss.length ? " · 缺 " + miss.join(",") : "");
}

/** 主动 ping 一次 logcat，验证通道 */
function pingLogcat() {
  try {
    if (!window.Native) return "无桥";
    if (typeof Native.log === "function") {
      Native.log("ping " + nowHHMM() + " 通道测试");
      return "已发送";
    }
    if (typeof Native.logBatch === "function") {
      Native.logBatch(JSON.stringify([hhmmss() + " T ping 通道测试"]));
      return "已发送(batch)";
    }
    return "无可用的日志方法";
  } catch (e) {
    return "异常: " + ((e && e.message) || e);
  }
}
/** 运行状态快照，用于「诊断」页 */
function runtimeSnapshot() {
  const now = () => performance.now();
  const mem = performance.memory
    ? Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB"
    : "未知";

  const fails = netTrace.fail();
  return [
    { k: "页面", v: S.tab },
    { k: "持仓 / 自选", v: S.holdings.length + " / " + S.watch.length },
    { k: "资讯条数", v: (S.news || []).length },
    { k: "情绪板块", v: (S.mood || []).length },
    { k: "指数估值", v: S.idxVal ? Object.keys(S.idxVal.byCode || {}).length : 0 },
    { k: "涨停池", v: S.limit ? S.limit.upCount + " 涨 / " + S.limit.downCount + " 跌" : "无" },
    { k: "预测缓存", v: Object.keys(S.predict || {}).length },
    { k: "请求总数", v: netTrace.list.length },
    { k: "请求失败", v: fails.length + (fails.length ? "（" + fails[fails.length - 1].name + "）" : "") },
    { k: "JS 堆内存", v: mem },
    { k: "日志条数", v: diag.buf.length },
  ];
}

/**
 * 运行状态采样。
 *
 * 每 30 秒采一次，记录：
 *   内存  JS 堆 + Java 堆 + 设备可用内存
 *   CPU   进程累计 tick 的两次差值 / 时间 / 核数
 *   GPU   kgsl 节点忙碌度（能读到才有）
 *   帧率  requestAnimationFrame 实测（能直接反映卡不卡）
 *
 * 只在日志开关打开时运行，平时完全不采，避免监控本身成为负担。
 */
const perfMon = {
  timer: null,
  lastTicks: 0,
  lastAt: 0,
  frames: 0,
  fpsAt: 0,
  fps: 0,
  rafId: null,

  start() {
    if (!S.logOn) return;
    // 幂等：已经在跑就别重复起，否则日志里会看到两条「监控已启动」
    if (this.timer) return;
    this.stop();

    // 帧率：数 rAF 的次数，每秒结算一次
    const tick = () => {
      this.frames += 1;
      const now = Date.now();
      if (!this.fpsAt) this.fpsAt = now;
      else if (now - this.fpsAt >= 1000) {
        this.fps = Math.round(this.frames * 1000 / (now - this.fpsAt));
        this.frames = 0;
        this.fpsAt = now;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);

    diag.info('性能监控已启动');

    // 立刻同步采一条基线，确认采集链路通不通
    try { this._sampleInner(); } catch (e) {
      diag.error('首次采样失败', (e && e.message) || String(e));
    }

    this.timer = setInterval(() => this.sample(), 30000);
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  },

  sample(first) {
    if (!S.logOn) return;
    // 首次采样不看可见性，保证日志里一定有一条基线
    if (!first && document.hidden) return;
    try {
      this._sampleInner();
    } catch (e) {
      diag.error('性能采样异常', (e && e.message) || String(e));
    }
  },

  _sampleInner() {

    let nat = {};
    try {
      if (window.Native && Native.getStats) {
        nat = JSON.parse(Native.getStats() || "{}");
      }
    } catch (e) { /* 无桥就只看 JS 侧 */ }

    // CPU：用两次采样的 tick 差值算占用率
    let cpuTxt = "";
    const now = Date.now();
    if (nat.cpuTicks != null && this.lastTicks && this.lastAt) {
      const dt = (now - this.lastAt) / 1000;
      const dTick = nat.cpuTicks - this.lastTicks;
      const hz = 100;   // Linux USER_HZ
      const cores = nat.cpuCores || 1;
      if (dt > 0) {
        const pct = (dTick / hz) / dt / cores * 100;
        cpuTxt = " CPU " + pct.toFixed(1) + "%";
      }
    }
    if (nat.cpuTicks != null) { this.lastTicks = nat.cpuTicks; this.lastAt = now; }

    let jsHeap = "";
    try {
      if (performance.memory) {
        jsHeap = " JS堆 " + Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB";
      }
    } catch (e) { /* ignore */ }

    const parts = [];
    // 刚启动时 rAF 还没跑满一秒，fps 是 0，标成「测量中」而不是显示 0
    parts.push("帧率 " + (this.fps || "测量中"));
    if (nat.heapUsed != null) parts.push("堆 " + nat.heapUsed + "/" + nat.heapMax + "MB");
    if (jsHeap) parts.push(jsHeap.trim());
    if (nat.deviceAvail != null) parts.push("设备余 " + nat.deviceAvail + "MB");
    if (nat.gpuBusy != null && nat.gpuBusy >= 0) parts.push("GPU " + nat.gpuBusy + "%");
    if (nat.threads != null) parts.push("线程 " + nat.threads);
    if (cpuTxt) parts.push(cpuTxt.trim());
    parts.push("DOM " + document.querySelectorAll("*").length);

    diag.info("性能 " + parts.join(" · "));

    // 掉帧告警：低于 45 帧说明主线程被堵了，值得记一笔
    if (this.fps > 0 && this.fps < 45) {
      diag.warn("掉帧 " + this.fps + "fps", "DOM " + document.querySelectorAll("*").length);
    }
  },
};
/* ---------------- 数据刷新 ---------------- */

/**
 * 检查基金持仓结构是否更新。
 *
 * 基金按季度披露持仓（季报 15 个工作日内、半年报/年报更全），
 * 公告出来后天天基金才会更新页面。这里是「每天主动看一眼」：
 * 发现有新的报告期，就丢掉旧的预估缓存重新算。
 *
 * 不这么做的话，季报换了仓，预估还按三个月前的持仓在算，
 * 越算越偏，用户却完全无从察觉。
 */
async function refreshReports() {
  if (!S.holdings.length) return;

  // 每天只查一次，用本地日期做闸门
  const gate = 'reportCheckDay';
  if (db.get(gate) === todayStr()) return;
  db.set(gate, todayStr());

  let changed = 0;
  for (const h of S.holdings) {
    try {
      const r = await api.stockHoldingsEx(h.code, 50);
      if (!r || !r.report) continue;

      const known = db.get('report_' + h.code);
      S.reportOf[h.code] = r.report;

      if (known && r.report !== known) {
        // 有新报告期：换掉缓存，让预估按新持仓重算
        S.holdCache[h.code] = { data: r, at: Date.now() };
        delete S.predict[h.code];
        changed += 1;
      }
      db.set('report_' + h.code, r.report);
    } catch (e) { /* 单只失败不影响其他 */ }
  }

  // 有新季报就重算预估，但不弹窗——用户没做任何操作
  if (changed) refreshPredict();
}

/**
 * 是否处于盘中交易时段。
 *
 * 刷新频率按这个走：盘中要勤刷，收盘后数据根本不动，
 * 再频繁请求只是耗电和浪费流量。
 */
function isTradingNow() {
  const d = new Date(nowMs());
  const day = d.getDay();
  if (day === 0 || day === 6) return false;   // 周末
  const hm = d.getHours() * 100 + d.getMinutes();
  // A 股 9:15~11:30 / 13:00~15:00，港股延到 16:10，取并集
  return (hm >= 915 && hm <= 1130) || (hm >= 1300 && hm <= 1610);
}

/**
 * 全量刷新。
 *
 * force=true 表示「不管内存里有没有，全部重新拉一遍」——
 * 用于每次打开 App、以及从后台切回前台，
 * 保证用户看到的永远是当下的数据，而不是上次留下的快照。
 *
 * 历史净值（S.full）例外：它一天只增加一条，
 * 没必要每次启动都重新下载几百 KB，按天失效就够了。
 */
/**
 * 全量刷新。
 *
 * 加了重入锁和节流，这两个都是日志逼出来的：
 *
 * 日志里同一秒出现两遍完全相同的「净值校准 + 刷新情绪 + 刷新资讯」，
 * 线程数一度冲到 97。原因是 visibilitychange 和原生的 onResume
 * 会在切回前台时同时触发，两边都调 refreshAll，于是并发跑了两遍。
 *
 * 重入锁：正在跑就直接返回，不叠加。
 * 节流：非强制刷新在 8 秒内只做一次，避免用户来回切页面时反复打网络。
 */
let _refreshBusy = false;
let _refreshAt = 0;
const REFRESH_GAP = 8000;

async function refreshAll(force) {
  if (_refreshBusy) return;
  if (!force && Date.now() - _refreshAt < REFRESH_GAP) return;

  _refreshBusy = true;
  _refreshAt = Date.now();
  try {
    if (force) {
      S.nav = {};
      S.gz = {};
      S.predict = {};
      S.predictAt = null;
      const lastDay = db.get('fullDay') || '';
      if (lastDay !== todayStr()) {
        S.full = {};
        db.set('fullDay', todayStr());
      }
    }

    await refreshNav();
    render();

    refreshIndices().then(render);
    refreshMarket();
    await refreshPredict();
    refreshReports();

    /*
     * 情绪和资讯只在这两个页面真的会用到时才刷。
     * 之前是无条件拉，用户在资产页也照样发请求，
     * 白白占带宽和线程。
     */
    const t = S.tab;
    if (t === 'discover' || t === 'mood' || t === 'news') {
      if (!S.mood || force) refreshMood();
      if (!S.news || force) refreshNews();
    }

    if (t === 'market' || t === 'sectorDetail') refreshHot();

    /*
     * AI 误差校准 —— 必须放在**所有数据刷新之后**。
     *
     * 它要读的正是上面刚结算完的误差账本（predict.learnAll 在
     * refreshNav 里跑完）和最新的季报报告期；早于这一步，等于
     * 拿着上一轮的数据做判断，那校准出来的权重是错的。
     *
     * 而且**不 await**：它要跑十几秒甚至更久，绝不能挡住界面。
     * 它自己在内部串行、限流、失败退避（见 ai 模块的四层保护）。
     */
    ai.runAll(false).catch(() => {});
  } finally {
    _refreshBusy = false;
  }
}


async function refreshNav() {
  const codes = new Set([
    ...S.holdings.map(h => h.code),
    ...S.watch.map(w => w.code),
  ]);
  await Promise.all([...codes].map(async code => {
    /*
     * 净值取两条：最新一条 + 前一条。
     *
     * pingzhongdata（S.full 的来源）比 lsjz 慢一天，
     * 昨天收盘的净值它今天下午才更新。只信 full 时，
     * 算「今日 vs 昨日」找不到今天这条，涨跌幅会显示成 0——
     * 这就是「净值不准确」的根源。
     */
    try {
      const list = await api.navHistory(code, 2);
      if (list.length) {
        S.nav[code] = list[0];
        mergeNavIntoFull(code, list);
      }
    } catch (e) { /* ignore */ }
    // 全量历史：一次请求同时拿到净值曲线和分红事件，用于算含分红的收益
    if (!S.full[code]) {
      try { S.full[code] = await api.fundFull(code); } catch (e) { /* ignore */ }
    }
    try {
      const g = await api.gz(code);
      if (g) {
        S.gz[code] = {
          gsz: parseFloat(g.gsz) || 0,
          pct: parseFloat(g.gszzl),
          time: g.gztime || '',
        };
      }
    } catch (e) { /* ignore */ }
  }));

  // 净值更新后，用真实涨跌校准预测权重（同一天只学一次）
  try { await predict.learnAll(); } catch (e) { /* 忽略 */ }

  /*
   * 拿到净值历史之后再补流水基线。
   * 放在这里而不是启动时：inferStartDate() 要靠净值曲线反推买入日，
   * 冷启动那一刻 S.full 还是空的，反推不出来，只能等这一轮网络回来。
   */
  try { ensureTxBaseline(); } catch (e) { /* 忽略 */ }
}

/** 刷新所有持仓的盘中预估。 */
async function refreshPredict() {
  if (!S.predictOn || S.predBusy) return;
  const codes = [...new Set(S.holdings.map(h => h.code))];
  if (!codes.length) return;
  S.predBusy = true;
  try {
    S.predict = await predict.many(codes);
  } finally {
    S.predBusy = false;
  }
  render();
}

async function refreshIndices() {
  try {
    S.gidx = await api.allGlobal();
  } catch (e) { S.gidx = {}; }
  // 底部指数条：只挑我们关心的一小撮，顺序见 IDXBAR_ORDER
  S.indices = pickIdxbar(S.gidx);
}

/**
 * 拉取指数估值（PE / PB / 历史分位）。
 * 每日更新一次，缓存有效期设长一些。
 */
async function refreshIndexValuation() {
  try {
    const v = await api.indexValuation();
    if (v && (Object.keys(v.byCode).length || Object.keys(v.byName).length)) {
      S.idxVal = v;
      S.idxValAt = v.date || todayStr();
      cache.set('idxval', v);
    }
  } catch (e) { /* 估值是增强信息，失败保持原样 */ }
  render();
}

/** 拉取板块估值（PE / 市值），失败不影响行情页主体。 */
async function refreshValuation() {
  try {
    // 板块估值已改用蛋卷指数（S.idxVal），无需单独请求
    S.valuation = null;
  } catch (e) {
    /* 估值是增强信息，失败就保持原样 */
  }
  render();
}

/** 拉取全市场热力图（板块 + 成分股），行情页主力数据源。 */
async function refreshHeat(force) {
  /*
   * 重入保护。
   *
   * findfin 的热力图是全部数据源里最慢的一个，日志里见过
   * 9 秒、12 秒、23 秒。它同时被「进行情页」「20 秒定时器」
   * 「下拉刷新」三处触发，不挡住的话会叠成一串并发长请求，
   * 把连接池和线程都占住。慢请求叠起来是之前线程冲到 97 的元凶之一。
   */
  if (S.heatLoading) return;
  S.heatLoading = true;
  if (force) { S.heatErr = false; S.heatStale = false; }

  try {
    const h = await api.heatTree();
    if (h && h.boards && h.boards.length) {
      S.heat = h;
      S.heatAt = nowHHMM();
      S.heatErr = false;
    } else if (!S.heat) {
      S.heatErr = true;
    }
  } catch (e) {
    // 有旧数据就继续用旧的，别把已经画好的页面清空
    if (!S.heat) S.heatErr = true;
  } finally {
    S.heatLoading = false;
  }
  render();
}

/**
 * 热力图还没到位时的占位。
 *
 * 原来无论「正在加载」还是「已经失败」都只画骨架屏，
 * 接口挂掉时用户就对着永远不出现的骨架干等，也没有任何重试入口。
 * 现在失败态给一条明确的提示和重试。
 */
function heatPending() {
  if (!S.heatErr) return skeletonList(8, true);
  return '<div class="empty">板块行情暂时取不到'
    + '<br><span class="t-sm">数据源没有响应，可以点下面重试</span>'
    + '<br><br><span id="secRetry" class="t-accent">重新加载</span></div>';
}

async function refreshSectors(kind) {
  const k = kind || S.sectorKind;
  try {
    const list = await api.sectors(k);
    // 拿不到有效数据时保留旧数据，避免整页变空白
    if (list && list.length) S.sectors = list;
    else if (!S.sectors) S.sectors = [];
  } catch (e) {
    // 资金流只是补充信息，失败不打扰用户
    if (!S.sectors) S.sectors = [];
  }
  render();
}

/**
 * 启动时用本地缓存先铺一版内容（拼多多式「先出后补」）。
 * 返回命中的缓存项数，界面立刻可以看，不用对着加载中干等。
 */
function hydrateFromCache() {
  let hit = 0;

  const h = cache.get('heat');
  if (h && h.val && h.val.boards && h.val.boards.length) {
    S.heat = h.val;
    S.heatStale = !h.fresh;
    S.heatAge = h.age;
    S.heatAt = '缓存 ' + cache.ageText(h.age);
    hit++;
  }
  const iv = cache.get('idxval');
  if (iv && iv.val) { S.idxVal = iv.val; hit++; }
  const v = cache.get('valuation');
  if (v && v.val) { S.valuation = v.val; hit++; }
  const ho = cache.get('hot');
  if (ho && ho.val) {
    S.hot = ho.val;
    S.hotAt = '缓存 ' + cache.ageText(ho.age);
    hit++;
  }
  const g = cache.get('global');
  if (g && g.val) {
    S.gidx = g.val;
    S.indices = pickIdxbar(S.gidx);
    hit++;
  }
  return hit;
}

/**
 * 行情页统一刷新。
 * 一次并发拉齐：全市场热力图、板块估值、同花顺热榜、全球指数，
 * 只渲染一次，避免四个回调各 render 一遍造成闪烁。
 */
let marketBusy = false;
async function refreshMarket(opt) {
  if (marketBusy) return;
  marketBusy = true;
  try {
    const needGlobal = !S.gidx || !Object.keys(S.gidx).length;
    const b = await api.marketBundle({
      sectorKind: S.sectorKind || 'industry',
      withGlobal: needGlobal,
    });

    if (b.heat && b.heat.boards && b.heat.boards.length) {
      S.heat = b.heat;
      S.heatAt = nowHHMM();
      S.heatStale = false;
      cache.set('heat', b.heat);
    }
    if (b.idxVal && (Object.keys(b.idxVal.byCode).length || Object.keys(b.idxVal.byName).length)) {
      S.idxVal = b.idxVal;
      S.idxValAt = b.idxVal.date || todayStr();
      cache.set('idxval', b.idxVal);
    }
    if (b.valuation && Object.keys(b.valuation).length) {
      S.valuation = b.valuation;
      cache.set('valuation', b.valuation);
    }
    if (b.hot && (b.hot.concept.length || b.hot.industry.length)) {
      S.hot = b.hot;
      S.hotAt = nowHHMM();
      cache.set('hot', b.hot);
    }
    if (b.global && Object.keys(b.global).length) {
      S.gidx = b.global;
      S.indices = pickIdxbar(S.gidx);
      cache.set('global', b.global);
    }
  } catch (e) { /* 全部失败时保持旧数据 */ }
  marketBusy = false;
  render();
}

/** 拉取同花顺热榜（概念 + 行业）。 */
async function refreshHot() {
  S.hotLoading = true;
  try {
    const [concept, industry] = await Promise.all([
      api.thsHot('concept').catch(() => []),
      api.thsHot('industry').catch(() => []),
    ]);
    if (concept.length || industry.length) {
      S.hot = { concept, industry };
      S.hotAt = nowHHMM();
    }
  } catch (e) { /* ignore */ }
  S.hotLoading = false;
  render();
}

async function refreshMood() {
  diag.info('刷新情绪');
  // 涨停池和商品与情绪同源，一起拉，少一轮网络往返
  api.limitPool().then(v => { if (v) { S.limit = v; render(); } }).catch(() => {});
  api.commodities().then(v => { if (v && v.length) { S.commod = v; render(); } }).catch(() => {});

  try {
    const list = await api.moodBoard();
    if (list && list.length) S.mood = list;
    else if (!S.mood) S.mood = [];
  } catch (e) {
    if (!S.mood) S.mood = [];
  }
  render();
}

/**
 * 资讯：所有源一次性并行拉取，合并去重后按时间倒序。
 *
 * 用户不需要选渠道——每个源各有覆盖盲区，
 * 单独看任何一个都会漏消息，混在一起才接近「全市场在说什么」。
 * 某几个源挂掉也不影响整体，只要有一条成功就照常出列表。
 */
async function refreshNews() {
  diag.info('刷新资讯');
  S.newsErr = null;
  S.newsLoading = true;
  if (S.news === null) render();

  const results = await Promise.all(NEWS_SOURCES.map(async s => {
    try {
      const list = await api.newsFrom(s.id, 1, 20);
      return (list || []).map(n => Object.assign({}, n, {
        src: s.id, srcName: s.name,
      }));
    } catch (e) { return []; }
  }));

  // 去重：标题去掉标点空格后取前 40 字做指纹，同一事件多源报道只留最早的
  const seen = Object.create(null);
  const merged = [];
  let okSrc = 0;
  for (const list of results) {
    if (list.length) okSrc += 1;
    for (const n of list) {
      const key = (n.title || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 40);
      if (!key || seen[key]) continue;
      seen[key] = 1;
      merged.push(n);
    }
  }

  // 时间格式统一为 MM-DD HH:MM，同年内字典序即时间序
  merged.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

  S.news = merged;
  S.newsOk = okSrc;
  S.newsLoading = false;
  if (!merged.length) {
    S.newsErr = '所有资讯源都暂时不可用，请稍后下拉重试';
  } else {
    cache.set('news', { list: merged.slice(0, 120), at: Date.now() });
  }
  render();
}

/* ---------------- 左右滑动切换栏目 ----------------
 *
 * 微信那种：在页面区域左右划，切到相邻 tab。
 *
 * 难点不在滑动本身，在和另外两个手势共存：
 *
 *   1. 下拉刷新（垂直）
 *      起手先判主方向，垂直就让给下拉刷新，判定once锁定后不再改。
 *
 *   2. 屏幕边缘返回（系统手势）
 *      左右各留 24px 死区，让系统先接管。
 *      抢占系统返回手势会直接导致用户退不出去，这是大忌。
 *
 *   3. 横向可滚动内容
 *      列表里若有横向滚动区，让它自己滑。
 *
 * 只有主 tab 之间可切；详情页、收益率页不参与，
 * 否则用户在详情页一划就跳走，是灾难。
 * ---------------- */
const swipe = {
  ORDER: ['hold', 'watch', 'market', 'mood', 'news'],
  EDGE: 24,
  TRIGGER: 56,
  active: false,
  decided: '',
  x0: 0, y0: 0,
  dx: 0,

  init() {
    mainEl.addEventListener('touchstart', e => this.onStart(e), { passive: true });
    mainEl.addEventListener('touchmove', e => this.onMove(e), { passive: false });
    mainEl.addEventListener('touchend', e => this.onEnd(e), { passive: true });
    mainEl.addEventListener('touchcancel', () => this.reset(), { passive: true });
  },

  canSwipe() {
    if (S.tab === 'detail' || S.tab === 'sectorDetail'
      || S.tab === 'article' || S.tab === 'perf') return false;
    return this.ORDER.indexOf(S.tab) >= 0;
  },

  onStart(e) {
    if (!this.canSwipe() || !e.touches || !e.touches.length) return;
    const t = e.touches[0];
    const w = mainEl.clientWidth || window.innerWidth;
    if (t.clientX < this.EDGE || t.clientX > w - this.EDGE) return;
    this.active = true;
    this.decided = '';
    this.x0 = t.clientX;
    this.y0 = t.clientY;
    this.dx = 0;
  },

  onMove(e) {
    if (!this.active) return;
    const t = e.touches && e.touches[0];
    if (!t) return;

    const dx = t.clientX - this.x0;
    const dy = t.clientY - this.y0;

    if (!this.decided) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      this.decided = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'h' : 'v';
      if (this.decided === 'v') { this.active = false; return; }
    }
    if (this.decided !== 'h') return;

    const idx = this.ORDER.indexOf(S.tab);
    if (dx > 0 && idx === 0) return;
    if (dx < 0 && idx === this.ORDER.length - 1) return;

    this.dx = dx;
    const shift = Math.max(-30, Math.min(30, dx * 0.22));
    mainEl.style.transform = 'translate3d(' + shift + 'px,0,0)';
    mainEl.style.transition = 'none';

    if (e.cancelable) e.preventDefault();
  },

  onEnd() {
    if (!this.active) return;
    this.active = false;

    /*
     * 关键：只有真的横向滑动过才动 transform。
     *
     * 普通点击时这里如果去改 mainEl.style.transform，
     * WebView 会认为页面在动，直接把生成中的 click 事件取消掉——
     * 表现就是「点了没反应」。这是之前资讯点不进去的根因。
     */
    if (this.decided !== 'h' || Math.abs(this.dx) < 4) return;

    const dx = this.dx;
    const idx = this.ORDER.indexOf(S.tab);
    let next = idx;
    if (dx <= -this.TRIGGER && idx < this.ORDER.length - 1) next = idx + 1;
    else if (dx >= this.TRIGGER && idx > 0) next = idx - 1;

    this.settle(0);
    if (next !== idx) switchTab(this.ORDER[next]);
  },

  settle(to) {
    mainEl.style.transition = 'transform 180ms cubic-bezier(.32,.72,0,1)';
    mainEl.style.transform = 'translate3d(' + to + 'px,0,0)';
    setTimeout(() => {
      mainEl.style.transition = '';
      mainEl.style.transform = '';
    }, 190);
  },

  reset() {
    this.active = false;
    this.decided = '';
    mainEl.style.transition = '';
    mainEl.style.transform = '';
  },
};


/* ---------------- 下拉刷新 ----------------
 *
 * 每个页面下拉都刷新自己那一块数据，而不是无脑全刷。
 *
 * 关于「用户一直刷」：真有人在两秒内下拉八次，如果每次都打网络，
 * 既拿不到新数据，也白白耗流量和电。这里用指数退避：
 * 第 1~3 次随便刷，之后每次要求等待的时间翻倍，最长 30 秒。
 * 冷却中的下拉不会静默失败，会明确告诉用户还要等几秒。
 * ---------------- */
const pull = {
  active: false,
  startY: 0,
  dist: 0,
  THRESHOLD: 68,
  MAX: 110,
  loading: false,

  lastAt: 0,
  streak: 0,

  el: null,
  txtEl: null,

  init() {
    this.el = document.getElementById('ptr');
    this.txtEl = document.getElementById('ptrTxt');
    if (!this.el) return;

    mainEl.addEventListener('touchstart', e => this.onStart(e), { passive: true });
    mainEl.addEventListener('touchmove', e => this.onMove(e), { passive: false });
    mainEl.addEventListener('touchend', e => this.onEnd(e), { passive: true });
    mainEl.addEventListener('touchcancel', () => this.reset(), { passive: true });

    // 桌面/浏览器预览也能测
    let mouseDown = false;
    mainEl.addEventListener('mousedown', e => {
      if (mainEl.scrollTop <= 0) { mouseDown = true; this.onStart(e); }
    });
    window.addEventListener('mousemove', e => { if (mouseDown) this.onMove(e); });
    window.addEventListener('mouseup', e => {
      if (mouseDown) { mouseDown = false; this.onEnd(e); }
    });
  },

  /** 当前页面该刷什么 */
  taskOf() {
    const tab = S.tab;
    /*
     * 下拉是用户的显式动作，一律强制刷新。
     *
     * 原来资产页返回 refreshAll(false)，而它有个 8 秒节流窗口：
     * 启动刚刷完的 8 秒内再下拉，请求一个都不发，界面却照样
     * 显示「正在刷新…」再复位 —— 看着刷过了，其实什么都没发生。
     *
     * 另外 'watch' / 'mood' / 'news' 这三个 tab 早已被合并掉，
     * S.tab 不可能等于它们，对应的分支是够不着的死代码；
     * 发现页下拉实际落到最后的 refreshAll，情绪和资讯都没刷。
     */
    if (tab === 'hold') {
      return () => refreshAll(true);
    }
    if (tab === 'market') {
      return () => refreshMarket();
    }
    if (tab === 'discover') {
      return () => { refreshMood(); refreshNews(); refreshHot(); };
    }
    if (tab === 'detail' && S.detail) {
      return () => openDetail(S.detail.code, true);
    }
    if (tab === 'sectorDetail' && S.sectorDetail) {
      return () => openSectorDetail(S.sectorDetail.code, S.sectorDetail.name, true);
    }
    return () => refreshAll(false);
  },

  /**
   * 冷却检查。返回 0 表示可以刷，否则返回还需等待的秒数。
   *
   * 前 3 次不拦（正常使用就是零星刷几下），
   * 之后每次间隔要求翻倍，最多 30 秒，把疯狂下拉挡在网外。
   */
  cooldownLeft() {
    const now = Date.now();
    const freeRun = 3;
    if (this.streak < freeRun) return 0;
    const need = Math.min(Math.pow(2, this.streak - freeRun) * 1000, 30000);
    const left = need - (now - this.lastAt);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  },

  /** 一段时间不刷，连击计数自动回落 */
  decay() {
    clearTimeout(this._decayT);
    this._decayT = setTimeout(() => {
      this.streak = Math.max(0, this.streak - 1);
      if (this.streak) this.decay();
    }, 15000);
  },

  onStart(e) {
    if (this.loading) return;
    if (mainEl.scrollTop > 0) return;
    const t = e.touches ? e.touches[0] : e;
    this.active = true;
    this.startY = t.clientY;
    this.dist = 0;
  },

  onMove(e) {
    if (!this.active || this.loading) return;
    const t = e.touches ? e.touches[0] : e;
    const raw = t.clientY - this.startY;
    if (raw <= 0) { this.setDist(0); return; }

    // 顶部已滚下去就不接管，交还给正常滚动
    if (mainEl.scrollTop > 0) { this.reset(); return; }

    // 阻尼：越往下拉越费劲，手感更接近原生
    const d = Math.min(this.MAX, raw * 0.52);
    this.setDist(d);

    if (e.cancelable) e.preventDefault();
  },

  setDist(d) {
    this.dist = d;
    if (!this.el) return;
    // 只改 transform，不动布局
    this.el.style.transform = 'translateY(' + (-70 + d) + 'px)';
    const ready = d >= this.THRESHOLD;
    this.el.classList.toggle('ready', ready && !this.loading);
    if (!this.loading) {
      this.txtEl.textContent = ready ? '松手刷新' : '下拉刷新';
    }
  },

  onEnd() {
    if (!this.active) return;
    this.active = false;
    if (this.loading) return;

    if (this.dist >= this.THRESHOLD) this.fire();
    else this.reset();
  },

  reset() {
    this.active = false;
    this.dist = 0;
    if (!this.el) return;
    this.el.classList.remove('ready', 'loading');
    this.el.style.transform = 'translateY(-70px)';
    if (this.txtEl) this.txtEl.textContent = '下拉刷新';
  },

  async fire() {
    const wait = this.cooldownLeft();
    if (wait) {
      this.reset();
      toast('刷新太频繁，' + wait + ' 秒后再试');
      return;
    }

    this.loading = true;
    this.lastAt = Date.now();
    this.streak += 1;
    this.decay();

    if (this.el) {
      this.el.classList.add('loading');
      this.el.classList.remove('ready');
      this.el.style.transform = 'translateY(0px)';
    }
    if (this.txtEl) this.txtEl.textContent = '正在刷新…';

    try {
      await this.taskOf()();
    } catch (e) {
      toast('刷新失败，请稍后再试');
    }

    this.loading = false;
    if (this.el) {
      this.el.classList.remove('loading', 'ready');
      this.el.style.transform = 'translateY(-70px)';
    }
    if (this.txtEl) this.txtEl.textContent = '下拉刷新';
  },
};


/* ---------------- 正文提取（App 内完成，不打开原网页） ----------------
 *
 * 原生抓 HTML -> DOMParser 解析 -> 站点规则 / Readability -> 直接渲染。
 *
 * 相比「用 WebView 打开原页面再注入脚本」，这条路摆脱了三个问题：
 *   1. 注入时机不可控（页面没加载完就提取必然失败）
 *   2. 原页面的广告弹窗先闪一下再被清掉，观感很脏
 *   3. 要加载图片、字体、统计脚本，慢且费流量
 *
 * 现在只下载 HTML 本身（几十 KB），解析完立刻出正文。
 * ---------------- */

const ARTICLE_RULES = [
  {
    host: /(^|\.)sina\.(cn|com\.cn)$/,
    sel: [".article-content", "#artibody", ".article", ".main-content", ".feed-card-content", ".blk-container", ".art-content", "#article"],
    title: [".main-title", "h1", ".article-title", ".art-title", ".blk-title"],
  },
  {
    host: /(^|\.)10jqka\.com\.cn$/,
    sel: [".main-text", ".atc-content", ".news-content", "#content", "article"],
    title: [".main-title", "h1", ".atc-title", ".title"],
  },
  {
    host: /(^|\.)eastmoney\.com$/,
    sel: ["#ContentBody", ".article-content", "#contentApp", ".txtinfos", ".newsContent", ".article"],
    title: ["#ContentBody h1", ".article-title", "h1", ".title"],
  },
  {
    host: /(^|\.)(cs\.com\.cn|stcn\.com|cnstock\.com|yicai\.com)$/,
    sel: [".article-content", ".content", "#content", "article", ".detail-content"],
    title: ["h1", ".title", ".article-title"],
  },
  {
    host: /.*/,
    sel: ["article", ".article-content", ".post-content", ".entry-content", "#content", ".content"],
    title: ["h1", ".title"],
  },
];

/** 清洗文本：零宽字符、表情符号、装饰符 */
function cleanText(s) {
  return String(s == null ? "" : s)
    .replace(/[\u200B-\u200F\uFEFF\u2028\u2029\u00AD]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .replace(/[\u2600-\u27BF\u2B00-\u2BFF]/g, "")
    .replace(/[\uFE00-\uFE0F\u20E3]/g, "")
    .replace(/[ \t\u3000]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

const ARTICLE_KILL = "script,style,iframe,form,input,button,select,textarea,video,audio,svg,canvas,noscript,link";
const ARTICLE_NOISE = "[class*=ad-],[id*=ad-],[class*=advert],[class*=share],[class*=comment],[class*=recommend],[class*=related],[class*=qrcode],[class*=download],[class*=sidebar],[class*=toolbar],[class*=app-guide],[class*=subscribe]";

/** 清掉广告位、脚本、分享按钮等噪音 */
function cleanArticleBox(box) {
  box.querySelectorAll("img").forEach(im => {
    let src = im.getAttribute("data-src") || im.getAttribute("data-original")
      || im.getAttribute("data-actualsrc") || im.getAttribute("src") || "";
    if (!src || /^data:image\/gif/i.test(src) || /1x1|spacer|blank/i.test(src)) {
      im.remove(); return;
    }
    if (src.indexOf("//") === 0) src = "https:" + src;
    im.setAttribute("src", src);
    im.removeAttribute("width");
    im.removeAttribute("height");
    im.removeAttribute("style");
    im.setAttribute("loading", "lazy");
  });

  box.querySelectorAll(ARTICLE_KILL).forEach(n => n.remove());
  box.querySelectorAll(ARTICLE_NOISE).forEach(n => n.remove());

  /*
   * 拆掉所有超链接。
   *
   * 正文里的链接基本是「相关阅读」「原文出处」「免责声明」这类，
   * 留着只会误触跳转，把用户从正在读的文章里带走。
   * 这里保留文字、去掉 <a>，正文变成纯文本，只能阅读不能点走。
   */
  box.querySelectorAll("a").forEach(a => {
    const parent = a.parentNode;
    if (!parent) return;
    while (a.firstChild) parent.insertBefore(a.firstChild, a);
    a.remove();
  });

  /*
   * 顺手清掉内联事件。有些站点的图片或段落挂着 onclick
   * 去做「点击放大/跳转原文」，在 App 里这些行为不该发生。
   */
  box.querySelectorAll("*").forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });
}

/**
 * 抓取并提取一篇正文。
 * 失败抛错，由调用方决定怎么提示。
 */
async function fetchArticle(url) {
  const html = await httpGet(url, false, { tries: 2 });
  if (!html || String(html).length < 200) throw new Error("页面内容为空");

  const doc = new DOMParser().parseFromString(String(html), "text/html");
  let host = "";
  try { host = new URL(url).hostname; } catch (e) { host = ""; }

  // 相对链接补全，否则正文里的图和链接全废
  const baseEl = doc.createElement("base");
  baseEl.setAttribute("href", url);
  if (doc.head) doc.head.appendChild(baseEl);

  const rule = ARTICLE_RULES.find(r => r.host.test(host)) || ARTICLE_RULES[ARTICLE_RULES.length - 1];

  const pick = sels => {
    for (const s of sels) {
      const el = doc.querySelector(s);
      if (el && (el.textContent || "").replace(/\s/g, "").length >= 60) return el;
    }
    return null;
  };

  const titleEl = pick(rule.title || []);
  const bodyEl = pick(rule.sel || []);

  if (bodyEl) {
    const box = doc.createElement("div");
    box.innerHTML = bodyEl.innerHTML;
    cleanArticleBox(box);
    return {
      url,
      via: "site",
      title: cleanText(titleEl ? titleEl.textContent.trim() : (doc.title || "")),
      media: cleanText(host),
      byline: "",
      html: box.innerHTML,
    };
  }

  // 站点规则没命中，交给 Readability
  let art = null;
  try {
    if (typeof Readability !== "undefined") {
      art = new Readability(doc, { charThreshold: 120, keepClasses: false }).parse();
    }
  } catch (e) { art = null; }
  if (!art || !art.content) throw new Error("无法识别正文");

  const box2 = doc.createElement("div");
  box2.innerHTML = art.content;
  cleanArticleBox(box2);

  return {
    url,
    via: "readability",
    title: cleanText(art.title || doc.title || ""),
    media: cleanText(art.siteName || host),
    byline: cleanText(art.byline || ""),
    html: box2.innerHTML,
  };
}
/* ---------------- 渲染 ---------------- */
const mainEl = document.getElementById('main');

/* ---------------- 导航栈 ----------------
 * 二级/三级页（基金详情、板块详情、正文）不覆盖底部导航，
 * 但必须记住「从哪来」，返回时回到上一页而不是主界面。
 * 用栈而不是单个字段，支持 列表 → 板块详情 → 成分股 → 基金详情 这种多级跳转。
 */
const nav = {
  stack: [],

  /** 进入新页面前，把当前页压栈。 */
  push() {
    const cur = { tab: S.tab };
    if (S.tab === 'detail') cur.code = S.detail && S.detail.code;
    if (S.tab === 'sectorDetail') cur.code = S.sectorDetail && S.sectorDetail.code;
    // 同一页不重复压栈
    const top = nav.stack[nav.stack.length - 1];
    if (top && top.tab === cur.tab && top.code === cur.code) return;
    nav.stack.push(cur);
    if (nav.stack.length > 20) nav.stack.shift();
  },

  /** 返回上一页；栈空时回到主 tab。 */
  back(fallback) {
    const prev = nav.stack.pop();
    if (!prev) {
      S.tab = fallback || 'hold';
      render();
      return;
    }
    S.tab = prev.tab;
    if (prev.tab === 'detail' && prev.code) {
      openDetail(prev.code, true);
      return;
    }
    if (prev.tab === 'sectorDetail' && prev.code) {
      openSectorDetail(prev.code, prev.name, true);
      return;
    }
    render();
  },

  reset() { nav.stack.length = 0; },

  /**
   * 系统返回键的入口。
   * 有上一页就退回上一页，已经在主 tab 上才让系统退出 App。
   * 返回 true 表示「已消费这次返回」，原生侧不要退出。
   */
  onBack() {
    // 弹层优先关闭
    const sheet = document.getElementById('sheet');
    if (sheet && sheet.classList.contains('show')) { closeSheet(); return true; }

    // 历史收益率是持仓页的下级页，返回固定回持仓
    if (S.tab === 'settings') { S.tab = 'me'; syncBackState(); render(); return true; }

    if (S.tab === 'diag') { S.tab = 'me'; syncBackState(); render(); return true; }

    if (S.tab === 'perf') {
      S._playEnter = true;
      S.tab = 'hold';
      syncBackState();
      render();
      return true;
    }

    // 详情类页面：退回上一页
    if (S.tab === 'detail' || S.tab === 'sectorDetail' || S.tab === 'article') {
      nav.back(S.tab === 'detail' ? 'hold'
        : (S.tab === 'sectorDetail' ? 'market' : 'news'));
      return true;
    }

    // 主 tab 但栈里还有历史（例如从行情进入板块详情再回来）
    if (nav.stack.length) { nav.back('hold'); return true; }

    /*
     * 落在这里 = 主 tab 且没有可返回的层级。
     * 不做「先回首页」：资产 / 行情 / 发现 / 我的 是平级的，
     * 从行情被抛到资产页只会让人莫名其妙。直接交回系统退出 App。
     */
    return false;
  },
};

/* 渲染节流。
 *
 * 刷新时 refreshAll 会并发触发好几个异步任务，每个完成后都调 render，
 * 一帧里可能整块重建 DOM 五六次。这就是「刷新完卡一下、字发虚」的来源：
 * WebView 连续做几次大段 innerHTML 替换，主线程被占满，
 * 期间任何滚动或动画都掉帧。
 *
 * 用 requestAnimationFrame 合并：同一帧只渲染最后一次，
 * 中间那些请求直接丢掉，省下的全是白做的工作。
 */
let _renderQueued = false;

/**
 * 把「当前能不能返回上一页」同步给原生。
 *
 * 这个必须即时同步。
 * 原生在手指刚按下返回手势的那一刻就要拿到答案，才能决定
 * 是把页面跟着手指推走，还是交给系统退出 App。
 *
 * 以前这段放在 render() 里，而 render 现在用 requestAnimationFrame
 * 合并，会晚一帧。用户手快时原生拿到的是上一页的状态：
 * 该退页面的时候直接把 App 关了，或者该退出的却在原地打转。
 *
 * 所以凡是改变页面的地方都立刻调一次，不能等下一帧。
 */
/**
 * 这次返回键会不会被页面消费掉？
 *
 * 原生侧只有两条路：canGoBack=true 时把返回交给 JS 跑 nav.onBack()，
 * false 时直接 finish()。所以这个判断必须和 nav.onBack() 严格一致。
 *
 * 原来的判断漏了「弹层是否打开」：在首页打开搜索框 / 持仓菜单 / 主题选择
 * 之后按返回，JS 这边明明已经把这次返回算作「关弹层」，
 * 原生那边却认为无处可退，于是弹层没关、App 直接退到桌面。
 * 用户看到的就是「点了个菜单按返回，App 自己没了」。
 *
 * 顺手把恒真的 S.tab !== 'hold' 之外的冗余分支删掉——
 * 那七个条件全被它包含了，留着只会让人误读成「七个都要判」。
 */
function canConsumeBack() {
  const sheet = document.getElementById('sheet');
  if (sheet && sheet.classList.contains('show')) return true;   // 弹层优先
  if (S.tab === 'settings' || S.tab === 'diag' || S.tab === 'perf') return true;
  if (S.tab === 'detail' || S.tab === 'sectorDetail' || S.tab === 'article') return true;
  if (nav.stack.length) return true;

  /*
   * 四个主 tab（资产 / 行情 / 发现 / 我的）是**平级**的。
   *
   * 这里原来是「S.tab !== 'hold'」—— 意思是「在行情页按返回就跳去
   * 资产页」。实测很别扭：用户在行情页按返回，预期是退出，
   * 结果被莫名抛到资产页；而且从资产→行情→返回，会一直卡在资产页，
   * 要按第二次才退得出去。
   *
   * 平级页面之间不该用返回键导航（Android / Material 规范也是这么说的）。
   * 现在在这几个页面上按返回 = 直接交回系统退出 App。
   */
  return false;
}

function syncBackState() {
  try {
    if (window.Native && Native.updateCanGoBack) {
      Native.updateCanGoBack(canConsumeBack());
    }
  } catch (e) { /* 浏览器预览没有桥 */ }
}

/*
 * 系统返回键的统一入口，供原生 evaluateJavascript 调用。
 *
 * 这里必须显式挂在 window 上，原因很关键：
 *
 *   nav 是用 const 声明的，属于**全局词法绑定**——
 *   它只在全局词法环境里可见，**不会成为 window 的属性**。
 *   而原生注入的脚本写的是 window.nav && nav.onBack()：
 *   window.nav 永远是 undefined，整句被跳过，
 *   可笑的是函数后面还照样 return true，等于向原生谎称
 *   「这次返回我消费了」。
 *
 *   于是：进二级页按返回 → 什么都没发生，回不去；
 *   在首页按返回 → 返回 false，但原生那条分支压根不看返回值，
 *   于是也退不出去。
 *
 * 现在把契约钉死在一个显式的 window 函数上，不再依赖
 * 「函数声明会自动挂到 window」这种隐式行为。
 *
 * 返回 true  = 这次返回已被页面消费，App 不要退出。
 * 返回 false = 页面不管，交给原生退出 App。
 */
window.__onSystemBack = function () {
  try {
    if (!canConsumeBack()) return false;
    nav.onBack();
    return true;
  } catch (e) {
    // 出错就当「页面不管」，宁可让用户退出，也不要卡住返回键
    return false;
  }
};

/* ---------------- 预测性返回：手势跟手用 ----------------
 *
 * 侧滑返回的手势阶段要「露出下面那一页」，可单 WebView 架构下
 * 底下本来就是当前页 —— 直接推开只会看到「同一页叠两层」。
 *
 * 所以换个顺序做：
 *   1. 手势一开始，原生先把当前页截成图盖在最上层（同步，用户无感）
 *   2. 紧接着调 __beginBackPreview()：记一份状态快照，然后**真的执行返回**
 *      —— WebView 此刻已经渲染出目标页，只是被盖图挡着
 *   3. 盖图跟手平移，露出来的就是货真价实的目标页
 *   4. 手势取消 → __cancelBackPreview() 把状态回滚、重渲染回原页面，
 *      盖图滑回原位后撤掉，两层内容一致，衔接无缝
 *   5. 手势提交 → 盖图滑出淡出，目标页就位
 * ---------------- */

/** 返回前的状态快照，供手势取消时回滚 */
let _backSnap = null;

function _snapshotPage() {
  return {
    tab: S.tab,
    detail: S.detail,
    sectorDetail: S.sectorDetail,
    article: S.article,
    detailFrom: S.detailFrom,
    sectorFrom: S.sectorFrom,
    articleFrom: S.articleFrom,
    stack: nav.stack.slice(),
    scroll: mainEl ? mainEl.scrollTop : 0,
  };
}

function _restorePage(snap) {
  if (!snap) return;
  S.tab = snap.tab;
  S.detail = snap.detail;
  S.sectorDetail = snap.sectorDetail;
  S.article = snap.article;
  S.detailFrom = snap.detailFrom;
  S.sectorFrom = snap.sectorFrom;
  S.articleFrom = snap.articleFrom;
  nav.stack.length = 0;
  for (const x of snap.stack) nav.stack.push(x);
  renderNow();
  if (mainEl) mainEl.scrollTop = snap.scroll;
}

/**
 * 手势开始：记快照 + 立刻切到目标页。
 * 原生必须在调用它之前就把当前页截好图盖住，否则用户会看到瞬间换页。
 * 返回 true 表示确实切了页（原生据此决定要不要播跟手动画）。
 */
window.__beginBackPreview = function () {
  try {
    if (!canConsumeBack()) return false;
    _backSnap = _snapshotPage();
    nav.onBack();
    return true;
  } catch (e) {
    _backSnap = null;
    return false;
  }
};

/** 手势取消：回滚到原页面 */
window.__cancelBackPreview = function () {
  try {
    if (_backSnap) { _restorePage(_backSnap); _backSnap = null; }
  } catch (e) { /* ignore */ }
};

/** 手势提交：页面已经是目标页了，清掉快照即可 */
window.__commitBackPreview = function () {
  _backSnap = null;
};

function render() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => {
    _renderQueued = false;
    renderNow();
  });
}

/** 立即渲染，跳过节流。需要同步拿到 DOM 的场合用。 */
function renderNow() {
  // 定时刷新会重绘整页，先把滚动位置记下来，绘完再还原，
  // 否则盘中每刷一次就被弹回顶部，根本没法看列表。
  const keepTop = mainEl ? mainEl.scrollTop : 0;
  const keepWin = (typeof window !== 'undefined' && window.scrollY) || 0;

  // 隐藏金额是全局状态，挂在 body 上才能覆盖所有页面的金额
  document.body.classList.toggle('hideamt', !!S.hideAmount);

  // 标题
  const titles = {
    hold: '资产', watch: '资产', market: '行情',
    discover: '发现', mood: '发现', news: '发现',
    me: '我的', detail: '基金详情', sectorDetail: '板块详情',
    article: '正文', perf: '总资产涨跌',
  };
  document.getElementById('apptitle').textContent = titles[S.tab] || '养基宝';

  // 底部导航高亮（详情页仍高亮来源页）
  const navTab = (S.tab === 'detail') ? (S.detailFrom || 'hold')
    : (S.tab === 'sectorDetail') ? (S.sectorFrom || 'market')
    : (S.tab === 'article') ? (S.articleFrom || 'news')
    : S.tab;
  document.querySelectorAll('nav button').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === navTab);
  });

  // 芯片行（仅持仓页）
  /*
   * 分组芯片只在「持仓」分段下出现。
   * 资产页已经有 全部/持仓/自选 三个分段了，
   * 再叠一排分组芯片，两个「全部」会打架，用户也分不清在筛什么。
   */
  const chips = document.getElementById('chips');
  if (S.tab === 'hold' && (S.assetSeg || 'hold') === 'hold') {
    const groups = ['全部', ...new Set(S.holdings.map(h => h.group || '默认'))];
    chips.style.display = 'flex';
    chips.innerHTML = groups.map(g =>
      `<button class="chip ${g === S.group ? 'on' : ''}" data-group="${g}">${g}</button>`
    ).join('') + `<button class="chip add" id="chipAdd">＋</button>`;
  } else {
    chips.style.display = 'none';
    chips.innerHTML = '';
  }

  mainEl.innerHTML =
    S.tab === 'hold' ? viewAssets() :
    S.tab === 'watch' ? viewAssets() :
    S.tab === 'market' ? viewMarket() :
    (S.tab === 'discover' || S.tab === 'mood' || S.tab === 'news') ? viewDiscover() :
    S.tab === 'article' ? viewArticle() :
    S.tab === 'sectorDetail' ? viewSectorDetail() :
    S.tab === 'settings' ? viewSettings() :
    S.tab === 'diag' ? viewDiag() :
    S.tab === 'perf' ? viewPerf() :
    S.tab === 'detail' ? viewDetail() : viewMe();

  renderIdxbar();

  /* 页面进入动画。
   *
   * 关键：render() 是整块 innerHTML 重建，任何挂在元素上的 CSS 动画
   * 都会随之重播。所以定时刷新（25 秒一次）绝不能播动画，
   * 否则用户看到的就是「界面每隔一会儿自己抖一下、字还发虚」。
   *
   * 只有真正换页时才置 S._playEnter，播完立刻清掉。
   */
  if (S._playEnter) {
    S._playEnter = false;
    mainEl.classList.remove('view-enter');
    void mainEl.offsetWidth;
    mainEl.classList.add('view-enter');
  } else {
    mainEl.classList.remove('view-enter');
  }

  // 还原滚动位置
  if (mainEl && keepTop) mainEl.scrollTop = keepTop;
  if (keepWin) window.scrollTo(0, keepWin);

  syncBackState();
}

/* ---- 持仓 ---- */
/** 持仓排序：置顶优先，其次按当前排序方式。 */
const HOLD_SORTS = [
  { id: 'manual', name: '默认' },
  { id: 'value',  name: '市值' },
  { id: 'pnl',    name: '收益' },
  { id: 'pct',    name: '收益率' },
  { id: 'today',  name: '今日' },
];

function holdSorted(list) {
  const k = S.holdSort || 'manual';
  const arr = list.slice();
  const val = h => priceOf(h.code, h.costNav) * h.shares;
  const pnl = h => (priceOf(h.code, h.costNav) - h.costNav) * h.shares;
  const pct = h => {
    const p = priceOf(h.code, h.costNav);
    return h.costNav ? (p / h.costNav - 1) * 100 : 0;
  };
  const today = h => todayPctOf(h.code) || 0;

  if (k === 'value') arr.sort((a, b) => val(b) - val(a));
  else if (k === 'pnl') arr.sort((a, b) => pnl(b) - pnl(a));
  else if (k === 'pct') arr.sort((a, b) => pct(b) - pct(a));
  else if (k === 'today') arr.sort((a, b) => today(b) - today(a));

  // 置顶永远在最前
  arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return arr;
}

function viewHold() {
  const list = holdSorted(S.group === '全部'
    ? S.holdings
    : S.holdings.filter(h => (h.group || '默认') === S.group));

  /*
   * 当日盈亏的算法必须让「各基金之和」严格等于「总资产」的数字。
   *
   * 做法是全部按「今日现价 vs 上一交易日净值」逐只算差额再相加：
   *   单只当日盈亏  = (现价 - 昨净值) × 份额
   *   总当日盈亏    = Σ 单只当日盈亏 = 今日总资产 - 昨日总资产
   *   总涨跌幅      = 总当日盈亏 / 昨日总资产
   *
   * 这样加权口径天然一致：各基金涨跌幅按昨净值市值加权，
   * 加起来就是总涨跌幅，不会出现「各只都涨、总数却跌」的矛盾。
   */
  let total = 0, cost = 0, todayPnl = 0, prevTotal = 0, predPnl = 0, predCovered = 0;
  let cashDivTotal = 0, divFundCount = 0;
  for (const h of S.holdings) {
    const c = holdCalc(h, S.full[h.code]);
    const pair = navPairOf(h.code);
    const shares = +h.shares || 0;

    total += c.value;
    cost += c.principal;
    cashDivTotal += c.cashDiv;
    if (c.divCount) divFundCount += 1;

    if (pair) {
      prevTotal += pair.prevNav * shares;
      todayPnl += (pair.curNav - pair.prevNav) * shares;
    } else {
      prevTotal += c.value;
    }

    const pr = S.predict[h.code];
    if (pr && isFinite(pr.est)) {
      predPnl += c.value * pr.est / 100;
      predCovered += 1;
    }
  }
  // 现金分红是真金白银到手，必须计入总收益，否则分红除息那天会被当成亏损
  const profit = total - cost + cashDivTotal;
  const todayPct = prevTotal ? todayPnl / prevTotal * 100 : 0;

  /*
   * 预估 vs 实际。
   *
   *   actualPnl  用「最新已公布净值」算出来的真实当日盈亏
   *   estPnl     用盘中预估净值算出来的
   *
   * 两者口径不同，分开给用户看更诚实：
   * 盘中只有预估，收盘后才有实际。混在一起显示会让人
   * 分不清这个数字到底是估算还是已经确定的收益。
   */
  let actualPnl = 0, actualBase = 0, estPnl = 0, estBase = 0;
  for (const h of S.holdings) {
    const shares = +h.shares || 0;
    const q = S.nav[h.code];
    if (!q || !isFinite(q.nav)) continue;
    const tr = (S.full[h.code] && S.full[h.code].trend) || null;
    let prev = q.nav;
    if (tr) {
      for (let k = tr.length - 1; k > 0; k--) {
        if (tr[k].date === q.date) { prev = tr[k - 1].nav; break; }
      }
    }
    if (prev) {
      actualBase += prev * shares;
      actualPnl += (q.nav - prev) * shares;
    }

    const pr = S.predict[h.code];
    if (pr && isFinite(pr.est)) {
      estBase += q.nav * shares;
      estPnl += q.nav * shares * pr.est / 100;
    }
  }
  const actualPct = actualBase ? actualPnl / actualBase * 100 : null;
  const estPct = estBase ? estPnl / estBase * 100 : null;

  let html = `<div class="asset">
    <div class="label t-pointer">账户资产
      <span class="eye" id="toggleEye">${EYE_ICONS}</span>
      <span style="margin-left:auto;font-size:var(--fs-xs);color:var(--dim)">
        ${isTradingNow() ? '盘中 · 实时' : '收盘'}</span>
    </div>
    <div class="row1">
      <div class="big">${fmt(total)}</div>
      <div class="today ${pctCls(todayPnl)}">${moneyTxt(todayPnl)}
        <small style="font-size:var(--fs-sm);opacity:.75">${pctTxt(todayPct)}</small>
      </div>
    </div>
    <div class="sub">
      <span>累计 ${moneyTxt(profit)}</span>
      <span class="${pctCls(profit)}">${pctTxt(cost ? profit / cost * 100 : 0)}</span>
    </div>
    ${cashDivTotal > 0 ? `<div class="predrow">
      <span class="pill">已收现金分红</span>
      <span class="up t-bold">+${fmt(cashDivTotal)}</span>
      <span style="color:var(--dim);font-size:var(--fs-sm)">
        ${divFundCount} 只 · 已计入累计收益</span>
    </div>` : ''}
    ${(() => {
      const pv = portfolioValuation();
      if (!pv) return '';
      const lvl = pv.pct == null ? '' : (pv.pct > 0.8 ? '偏高' : pv.pct < 0.3 ? '偏低' : '适中');
      const cls = pv.pct == null ? '' : (pv.pct > 0.8 ? 'down' : pv.pct < 0.3 ? 'up' : '');
      return '<div class="predrow">'
        + '<span class="pill">组合估值</span>'
        + '<span class="t-bold">PE ' + fmt(pv.pe, 1) + '</span>'
        + '<span class="' + cls + '">' + lvl
        + (pv.pct != null ? ' · 分位 ' + fmt(pv.pct * 100, 0) + '%' : '') + '</span>'
        + '<span class="t-dim t-xs">'
        + pv.matched + '/' + pv.total + ' 只有对应指数</span></div>';
    })()}
    ${predCovered ? `<div class="predrow">
      <span class="pill pred">盘中</span>
      <span style="color:var(--dim);font-size:var(--fs-sm)">
        ${predCovered}/${S.holdings.length} 只已按预估净值计入今日盈亏</span>
    </div>` : ''}
  </div>`;

  if (!list.length) {
    html += `<div class="empty">还没有持仓
      <br>用下面的「添加基金」搜索添加</div>`;
  } else {
    html += `<div class="colhead">
      <div class="c0">基金名称</div>
      <div class="c1">今日</div>
      <div class="c2">持有收益</div>
    </div>`;

    for (const h of list) {
      const c = holdCalc(h, S.full[h.code]);
      const tp = todayPctOf(h.code);
      const pr = S.predict[h.code];
      const est = pr ? pr.est : null;
      const tn = FUND_TYPE_NAME[c.type] || '';

      // 状态行：类型 + 净值日期滞后 + 分红
      const bits = [];
      if (tn) bits.push(tn);
      if (c.lagDays != null && c.lagDays >= 2) bits.push('净值 T+' + c.lagDays);
      // 预测依据：让用户知道这个预估是怎么来的，而不是一个来路不明的数字
      if (pr && pr.method === 'index') bits.push('跟 ' + pr.indexName);
      else if (pr && pr.method === 'holdings') bits.push('重仓加权');
      else if (pr && pr.method === 'recent') bits.push('近期均值');
      if (c.divCount) {
        bits.push(c.divMode === 'cash'
          ? '分红 ' + c.divCount + ' 次 · 已收 ¥' + fmt(c.cashDiv)
          : '分红 ' + c.divCount + ' 次 · 再投');
      }

      html += `<div class="fund" data-code="${h.code}">
        <div class="c0">
          <div class="nm">${h.name || h.code}</div>
          <div class="amt">¥${fmt(c.value)}
            ${est != null ? `<span class="est ${pctCls(est)}">预估 ${pctTxt(est)}`
              + `${pr && pr.indexName ? ' · ' + pr.indexName : ''}</span>` : ''}
          </div>
          ${bits.length ? `<div class="amt" style="color:var(--dim);font-size:var(--fs-xs)">
            ${bits.join(' · ')}</div>` : ''}
        </div>
        <div class="c1 ${pctCls(tp || 0)}">${tp == null ? '--' : pctTxt(tp).replace('%', '')}</div>
        <div class="c2 ${pctCls(c.profit)}">${moneyTxt(c.profit)}
          <small>${pctTxt(c.profitPct)}</small></div>
      </div>`;
    }

    html += `<div class="predbar">
      <span class="t">盘中预估 · 按基金类型自动匹配模型</span>
      <button id="predToggle" class="${S.predictOn ? 'on' : ''}">
        ${S.predictOn ? '已开启' : '已关闭'}</button>
    </div>

    <div class="secline">
      <span>共 ${list.length} 只</span>
      <span id="btnBatch">批量管理</span>
    </div>`;
  }

  if (S.indices.length) {
    html += `<div class="secline" style="border-top:1px solid var(--line)">
      <span>共 ${list.length} 只 · 盘中 25 秒自动刷新</span></div>`;
  }

  return html;
}


/* ---------------- 资产页（持仓 + 自选合并） ----------------
 *
 * 以前持仓和自选是两个 tab，但用户看的是同一件事：
 * 「我关心的这些基金现在怎么样」。
 * 分成两页的结果是来回切、还得记住哪只在哪个页。
 *
 * 合并后：一份列表，持仓的显示金额和收益，自选的只显示净值涨跌。
 * 顶部资产卡只在有持仓时出现。
 * ---------------- */

/** 当前应该显示的基金列表 */
function assetList() {
  const seg = S.assetSeg || "hold";
  const hold = S.holdings.map(h => Object.assign({}, h, { _held: true }));
  const watch = S.watch
    .filter(w => !S.holdings.some(h => h.code === w.code))
    .map(w => Object.assign({}, w, { _held: false }));

  if (seg === "hold") return hold;
  if (seg === "watch") return watch;
  // 全部：持仓在前，自选在后
  return hold.concat(watch);
}

/** 分组筛选（只对持仓生效） */
function assetFiltered() {
  const list = assetList();
  if (S.group === "全部") return list;
  return list.filter(x => x._held && (x.group || "默认") === S.group);
}

function viewAssets() {
  const list = assetFiltered();
  const hasHold = S.holdings.length > 0;

  /* 汇总 */
  let total = 0, cost = 0, todayPnl = 0, prevTotal = 0, cashDivTotal = 0, divFundCount = 0;
  for (const h of S.holdings) {
    const c = holdCalc(h, S.full[h.code]);
    const pair = navPairOf(h.code);
    const shares = +h.shares || 0;
    total += c.value;
    cost += c.principal;
    cashDivTotal += c.cashDiv;
    if (c.divCount) divFundCount += 1;
    if (pair) {
      prevTotal += pair.prevNav * shares;
      todayPnl += (pair.curNav - pair.prevNav) * shares;
    } else {
      prevTotal += c.value;
    }
  }
  const profit = total - cost + cashDivTotal;
  const todayPct = prevTotal ? todayPnl / prevTotal * 100 : 0;

  /*
   * 预估 vs 实际。
   *
   *   actualPct  用最新已公布净值算出来的真实当日涨跌
   *   estPct     用盘中预估净值算出来的
   *
   * 分开给用户看更诚实：盘中只有预估，收盘后才有实际。
   * 混在一起会让人分不清这数字是估算还是已经确定的收益。
   */
  let actualPnl = 0, actualBase = 0, estPnl = 0, estBase = 0;
  for (const h of S.holdings) {
    const shares = +h.shares || 0;
    const q = S.nav[h.code];
    if (!q || !isFinite(q.nav)) continue;

    const tr = (S.full[h.code] && S.full[h.code].trend) || null;
    let prev = q.nav;
    if (tr) {
      for (let k = tr.length - 1; k > 0; k--) {
        if (tr[k].date === q.date) { prev = tr[k - 1].nav; break; }
      }
    }
    if (prev) {
      actualBase += prev * shares;
      actualPnl += (q.nav - prev) * shares;
    }

    const pr = S.predict[h.code];
    if (pr && isFinite(pr.est)) {
      estBase += q.nav * shares;
      estPnl += q.nav * shares * pr.est / 100;
    }
  }
  const actualPct = actualBase ? actualPnl / actualBase * 100 : null;
  const estPct = estBase ? estPnl / estBase * 100 : null;

  /*
   * 把每只持仓的真实净值记进日志。
   *
   * 这是验证「净值准不准」最直接的办法：
   * 拿这里的数字和天天基金官网对比即可，不需要猜。
   */
  if (S.logOn && S.holdings.length) {
    const rows = S.holdings.map(h => {
      const q = S.nav[h.code];
      const pair = navPairOf(h.code);
      if (!q) return h.code + ':无数据';
      const prev = pair ? pair.prevNav : null;
      const tp = todayPctOf(h.code);
      return (h.name || h.code).slice(0, 8) + ' 净值' + q.nav
        + '(' + (q.date || '') + ') 昨' + (prev != null ? prev : '?')
        + ' 涨跌' + (tp != null ? tp.toFixed(2) + '%' : '?');
    });
    diag.info('持仓净值 ' + rows.join(' | '));
  }

  let html = "";

  if (hasHold) {
    const pv = portfolioValuation();
    /* ac-money 只是给「隐藏金额」用的作用域标记：
       我的页也有 .assetcard，不区分的话会把「2 只持仓」也糊掉 */
    html += '<div class="assetcard ac-money">';
    /*
     * 整张卡片可点，进「历史收益率」。
     *
     * 这个入口原来只挂在 #assetHead 上，而 #assetHead 长在
     * viewHold() 里 —— 那是个从来没被调用过的死函数
     * （renderNow 只调 viewAssets）。于是收益率页数据链路
     * 完全正常，用户却一个入口都找不到。
     */
    html += '<div class="ac-top t-pointer" id="assetHead">';
    html += '<span class="ac-label">总资产';
    if (!S.hideAmount) {
      html += '<span class="ac-eye" id="toggleEye">' + EYE_ICONS + '</span>';
    } else {
      html += '<span class="ac-eye" id="toggleEye">' + EYE_ICONS + '</span>';
    }
    html += '</span>';
    // 「›」是给用户的可点提示，不然没人会想到总资产卡能点开
    html += '<span class="ac-status">'
      + (isTradingNow() ? "盘中" : "收盘") + ' ›</span>';
    html += '</div>';

    html += '<div class="ac-num">' + fmt(total) + '</div>';

    html += '<div class="ac-row">';
    html += '<span class="ac-day ' + pctCls(todayPnl) + '">'
      + moneyTxt(todayPnl) + '<small>' + pctTxt(todayPct) + '</small></span>';
    html += '<span class="ac-sep"></span>';
    html += '<span class="ac-sum ' + pctCls(profit) + '">累计 ' + moneyTxt(profit) + '</span>';
    html += '</div>';

    /* 预估 vs 实际：两个口径分开写清楚 */
    if (estPct != null || actualPct != null) {
      html += '<div class="ac-est">';
      if (estPct != null) {
        html += '<span class="ae-item"><i>预估</i><b class="' + pctCls(estPct) + '">'
          + pctTxt(estPct) + '</b></span>';
      }
      if (actualPct != null) {
        html += '<span class="ae-item"><i>实际</i><b class="' + pctCls(actualPct) + '">'
          + pctTxt(actualPct) + '</b></span>';
      }
      html += '</div>';
    }

    if (pv) {
      const lvl = pv.pct == null ? "" : (pv.pct > 0.8 ? "偏高" : pv.pct < 0.3 ? "偏低" : "适中");
      html += '<div class="ac-tags">';
      html += '<span class="tag">组合 PE ' + fmt(pv.pe, 1) + '</span>';
      if (pv.pct != null) {
        html += '<span class="tag ' + (pv.pct > 0.8 ? "down" : pv.pct < 0.3 ? "up" : "")
          + '">' + lvl + ' ' + fmt(pv.pct * 100, 0) + '%</span>';
      }
      if (cashDivTotal > 0) {
        html += '<span class="tag up">分红 +' + fmt(cashDivTotal) + '</span>';
      }
      html += '</div>';
    }
    html += '</div>';
  }

  /* 分段 */
  const segs = [
    { id: "hold", name: "持仓 " + S.holdings.length },
    { id: "watch", name: "自选 " + S.watch.length },
  ];
  html += '<div class="assettabs">';
  for (const s of segs) {
    html += '<button data-aseg="' + s.id + '" class="'
      + ((S.assetSeg || "hold") === s.id ? "on" : "") + '">' + s.name + '</button>';
  }
  html += '</div>';

  /* 列表 */
  if (!list.length) {
    html += '<div class="empty">还没有基金'
      + '<br>用下面的「添加基金」搜索添加</div>';
  } else {
    for (const x of list) {
      html += x._held ? assetHoldRow(x) : assetWatchRow(x);
    }
  }

  /*
   * 添加基金的入口放在列表最后。
   *
   * 原来挂在顶栏的「＋」上：手要往上够，而且列表一长就离得远。
   * 放在末尾跟着列表滚，正好接在「我已经有的基金」后面 ——
   * 想加下一只时，视线本来就落在这里。
   * 空列表时也必须出现，否则新用户没有入口。
   */
  html += '<div class="addrow" id="addHold">'
    + '<span class="addplus">＋</span><span>添加基金</span></div>';

  if (list.length) {
    html += '<div class="assetend">共 ' + list.length + ' 只</div>';
  }
  return html;
}

/** 持仓行：金额 + 今日 + 收益 */
function assetHoldRow(h) {
  const c = holdCalc(h, S.full[h.code]);
  const tp = todayPctOf(h.code);
  const pr = S.predict[h.code];
  const est = pr ? pr.est : null;
  const tn = FUND_TYPE_NAME[c.type] || "";

  const bits = [];
  if (tn) bits.push(tn);
  if (c.lagDays != null && c.lagDays >= 2) bits.push("T+" + c.lagDays);
  if (c.divCount) {
    bits.push(c.divMode === "cash"
      ? "分红 " + c.divCount + " 次"
      : "分红再投 " + c.divCount + " 次");
  }

  return '<div class="fund" data-code="' + h.code + '">'
    + '<div class="c0">'
    + '<div class="nm">' + (h.name || h.code) + '</div>'
    + '<div class="amt">¥' + fmt(c.value)
    + (est != null ? '<span class="est ' + pctCls(est) + '">预估 ' + pctTxt(est) + '</span>' : "")
    + '</div>'
    + (bits.length ? '<div class="amt dim">' + bits.join(" · ") + '</div>' : "")
    + '</div>'
    + '<div class="c1 ' + pctCls(tp || 0) + '">'
    + (tp == null ? "--" : pctTxt(tp).replace("%", "")) + '</div>'
    + '<div class="c2 ' + pctCls(c.profit) + '">' + moneyTxt(c.profit)
    + '<small>' + pctTxt(c.profitPct) + '</small></div>'
    + '</div>';
}

/** 自选行：没有金额，只看净值涨跌 */
function assetWatchRow(w) {
  const q = S.nav[w.code];
  const tp = todayPctOf(w.code);
  return '<div class="fund" data-code="' + w.code + '">'
    + '<div class="c0">'
    + '<div class="nm">' + (w.name || w.code) + '</div>'
    + '<div class="amt">' + w.code + (q ? " · " + q.date : "") + '</div>'
    + '</div>'
    + '<div class="c1 ' + pctCls(tp || 0) + '">'
    + (tp == null ? "--" : pctTxt(tp).replace("%", "")) + '</div>'
    + '<div class="c2">' + (q ? fmt(q.nav, 4) : "--") + '</div>'
    + '</div>';
}

/* ---------------- 发现页（情绪 + 资讯） ----------------
 *
 * 情绪和资讯本质上是同一件事：看市场正在发生什么。
 * 一个是量化视角（板块热度、涨跌、连板），
 * 一个是事件视角（新闻、公告、异动）。
 * 分成两个 tab 反而让用户来回切，合并成一个更连贯。
 * ---------------- */

function viewDiscover() {
  const seg = S.discoverSeg || "mood";

  let html = '<div class="assettabs" style="margin-top:var(--sp-3)">';
  html += '<button data-dseg="mood" class="' + (seg === "mood" ? "on" : "") + '">板块情绪</button>';
  html += '<button data-dseg="news" class="' + (seg === "news" ? "on" : "") + '">资讯</button>';
  html += '</div>';

  if (seg === "news") return html + viewNewsFlow();
  return html + viewMoodContent();
}

/** 情绪内容（原情绪页，去掉自己的分段） */
function viewMoodContent() {
  const list = S.mood || [];
  if (!S.mood) return skeletonList(5, false);
  if (!list.length) {
    return '<div class="empty">暂无情绪数据'
      + '<br><span id="moodRetry" class="t-accent">点此重试</span></div>';
  }

  const rising = list.filter(x => x.score >= 58).length;
  const falling = list.filter(x => x.score < 42).length;

  let html = limitCard();

  html += '<div class="pcard" style="padding:var(--sp-3) var(--sp-4)">';
  html += '<div style="display:flex;gap:var(--sp-4);font-size:var(--fs-sm);color:var(--dim)">';
  html += '<span>覆盖 <b class="t-fg2">' + list.length + '</b> 个板块</span>';
  html += '<span class="up">升温 <b>' + rising + '</b></span>';
  html += '<span class="down">降温 <b>' + falling + '</b></span>';
  html += '</div></div>';

  const TOP = 12;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const rank = i + 1;
    const color = m.color || "var(--dim)";
    const dim = i >= TOP ? " mood-dim" : "";

    html += '<div class="momcard pizza' + dim + '"'
      + ' data-mom-name="' + encodeURIComponent(m.name) + '">';

    html += '<div class="mhead">';
    html += '<span class="rank' + (rank <= 3 ? " top" : "") + '">' + rank + '</span>';
    html += '<span class="mname">' + m.name + '</span>';
    html += '<span class="mchg ' + pctCls(m.pct) + '">'
      + (m.pct != null ? pctTxt(m.pct)
        : (m.heat != null ? '热 ' + fmt(m.heat, 0) : "--")) + '</span>';
    html += '</div>';

    html += '<div class="mscore">';
    html += '<span style="font-size:var(--fs-3xl);font-weight:700;color:' + color + ';line-height:1">'
      + Math.round(m.score) + '</span>';
    html += '<span style="color:var(--dim);font-size:var(--fs-xs)">/100</span>';
    html += '<span style="margin-left:auto;color:' + color
      + ';font-size:var(--fs-sm);font-weight:600">' + m.status + '</span>';
    html += '</div>';

    html += '<div class="mbar"><i style="width:' + Math.min(m.score, 100)
      + '%;background:' + color + '"></i></div>';

    html += newsBlock(m.name, 3);
    html += '</div>';
  }

  html += '<div class="newsend">情绪分由涨跌幅、涨跌家数、平台热度合算，50 为中性</div>';
  return html;
}

/** 资讯流（带板块筛选） */
function viewNewsFlow() {
  const all = S.news || [];
  if (S.newsLoading && !all.length) return skeletonList(6, false);
  if (S.newsErr && !all.length) {
    return '<div class="empty">' + S.newsErr
      + '<br><br><span id="newsRetry" class="t-accent">点此重试</span></div>';
  }
  if (!all.length) {
    return '<div class="empty">暂无资讯<br><span class="t-sm">下拉可刷新</span></div>';
  }

  const pick = S.newsSector || "";

  /* 板块筛选：只列出当天确实有消息的板块，避免一屏都是空的 */
  const countBy = Object.create(null);
  for (const n of all) {
    const s = newsSectorOf(n.title || "");
    if (s) countBy[s] = (countBy[s] || 0) + 1;
  }
  const sectors = Object.keys(countBy)
    .sort((a, b) => countBy[b] - countBy[a])
    .slice(0, 12);

  let html = "";
  if (sectors.length) {
    html += '<div class="newsfilter">';
    html += '<button data-nsec="" class="' + (pick ? "" : "on") + '">全部 ' + all.length + '</button>';
    for (const s of sectors) {
      html += '<button data-nsec="' + encodeURIComponent(s) + '" class="'
        + (pick === s ? "on" : "") + '">' + s + ' ' + countBy[s] + '</button>';
    }
    html += '</div>';
  }

  const rows = pick
    ? all.filter(n => newsSectorOf(n.title || "") === pick)
    : all;

  if (!rows.length) {
    return html + '<div class="empty">该板块今天没有相关消息</div>';
  }

  for (const n of rows) {
    const t = n.title || "";
    if (!t) continue;
    const sec = newsSectorOf(t);

    html += '<div class="newsrow"'
      + ' data-article="' + encodeURIComponent(n.url || "") + '"'
      + ' data-title="' + encodeURIComponent(t) + '">';
    html += '<div class="newstitle">' + t + '</div>';
    html += '<div class="newsmeta">';
    html += '<span class="newssrc">' + (n.media || "资讯") + '</span>';
    if (sec) html += '<span class="t-dim t-xs">' + sec + '</span>';
    html += '<span class="newstime">' + (n.time || "") + '</span>';
    html += '</div></div>';
  }

  html += '<div class="newsend">' + rows.length + ' 条 · '
    + (S.newsOk || 0) + ' 个渠道整合</div>';
  return html;
}

/**
 * 判断一条新闻属于哪个板块。
 *
 * 用 MOOD_ALIAS 里的关键词表反查：标题命中哪个板块的词，就算哪个板块。
 * 匹配不到就返回 null，界面上不打标签，不硬凑。
 */
function newsSectorOf(title) {
  if (!title) return null;
  for (const name in MOOD_ALIAS) {
    const words = MOOD_ALIAS[name];
    for (const w of words) {
      if (w && w.length >= 2 && title.indexOf(w) >= 0) return name;
    }
  }
  return null;
}

/**
 * 数据源自检。
 *
 * 把所有真实用到的接口逐个打一遍，报告：能不能通、多久返回、拿到多少条。
 * 出问题时一眼能看出是「网络挂了」还是「某个源改版了」。
 */
async function runDiagnostics() {
  const rows = [];
  const t = async (name, fn) => {
    const t0 = Date.now();
    try {
      const v = await fn();
      let n = 0;
      if (Array.isArray(v)) n = v.length;
      else if (v && typeof v === "object") n = Object.keys(v).length;
      rows.push({ name, ok: true, ms: Date.now() - t0, n });
    } catch (e) {
      rows.push({ name, ok: false, ms: Date.now() - t0, err: (e && e.message) || "失败" });
    }
  };

  await t("热力图（涨跌+板块）", () => api.heatTree());
  await t("同花顺热榜（概念）", () => api.thsHot("concept"));
  await t("同花顺热榜（行业）", () => api.thsHot("industry"));
  await t("指数估值（蛋卷）", () => api.indexValuation());
  await t("涨停/跌停池", () => api.limitPool());
  await t("商品行情（金/油/铜）", () => api.commodities());
  await t("全球指数（腾讯）", () => api.allGlobal());
  await t("指数日线（沪深300）", () => api.indexHistory("sh000300", 30));
  await t("宝妈指数", () => api.momIndex());
  await t("资讯·新浪", () => api.newsFrom("sina", 1, 5));
  await t("资讯·同花顺", () => api.newsFrom("ths", 1, 5));
  await t("资讯·东财要闻", () => api.newsFrom("em", 1, 5));
  await t("资讯·国际", () => api.newsFrom("em-global", 1, 5));
  await t("资讯·商品市场", () => api.newsFrom("em-macro", 1, 5));
  await t("基金净值（110011）", () => api.navHistory("110011", 3));
  await t("基金全量历史", () => api.fundFull("110011"));
  await t("基金重仓股", () => api.stockHoldingsEx("110011", 10));
  await t("正文提取（东财）", () => fetchArticle("https://finance.eastmoney.com/news/1345,202610203901274671.html"));

  const okN = rows.filter(r => r.ok).length;
  diag.info('自检 ' + okN + '/' + rows.length + ' 可用');
  for (const r of rows) {
    if (!r.ok) diag.warn('自检失败 ' + r.name, r.err);
  }

  let html = '<div class="pcard" style="margin-top:0">';
  html += '<div class="pcard-cap">数据源自检 · ' + okN + '/' + rows.length + ' 可用</div>';
  for (const r of rows) {
    html += '<div class="kv"><span class="k" style="font-size:var(--fs-sm)">' + r.name + '</span>';
    html += '<span class="v" style="font-size:var(--fs-sm);'
      + (r.ok ? "" : "color:var(--up)") + '">';
    html += r.ok ? (r.n + " 条 · " + r.ms + "ms") : r.err;
    html += '</span></div>';
  }
  html += '</div>';

  return html;
}

/** 调试日志页 */
function viewDiag() {
  // 自检结果模式
  if (S.diagMode === 'check') {
    let html = '';

    /* 运行状态快照放最上面：出问题时先看这个，能立刻判断是哪一层的问题 */
    html += '<div class="pcard" style="margin-top:0">';
    html += '<div class="pcard-cap">运行状态</div>';
    for (const r of runtimeSnapshot()) {
      html += '<div class="kv"><span class="k t-sm">' + r.k + '</span>'
        + '<span class="v t-sm">' + r.v + '</span></div>';
    }
    html += '</div>';

    /* 最近的失败请求 */
    const fails = netTrace.fail().slice(-6).reverse();
    if (fails.length) {
      html += '<div class="pcard">';
      html += '<div class="pcard-cap">最近失败的请求</div>';
      for (const f of fails) {
        html += '<div class="kv"><span class="k t-xs" style="max-width:58%;'
          + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
          + f.name + '</span>';
        html += '<span class="v t-xs" style="color:var(--up);text-align:right;'
          + 'max-width:40%">' + (f.err || '') + '</span></div>';
      }
      html += '</div>';
    }

    /*
     * 注意这里是 html += 而不是 html =。
     * 用 = 会把上面刚拼好的「运行状态」和「最近失败的请求」
     * 两整块覆盖掉 —— 出问题时最该看的就是这两块，却永远看不到。
     */
    if (!S.diagResult) {
      html += '<div class="empty">正在逐个测试数据源…<br>'
        + '<span class="t-sm">大约 10 秒</span></div>';
    } else {
      html += S.diagResult;
      html += '<div class="pcard"><div class="pcard-cap">说明</div>'
        + '<div class="t-sm t-fg2" style="line-height:1.8">'
        + '显示「N 条 · Xms」表示可用；显示红色文字是失败原因。<br>'
        + '东财 push2 系列在当前网络下常常整片不可达，'
        + '那部分的板块 PE 会显示 --，属于已知情况。</div></div>';
    }
    return html;
  }

  diag.load();
  const list = diag.buf.slice(-150).reverse();

  let html = '<div class="pcard" style="margin-top:0">';
  html += '<div style="display:flex;align-items:center;gap:var(--sp-3);margin-bottom:var(--sp-3)">';
  html += '<span class="pcard-cap" style="margin:0">' + diag.buf.length + ' 条日志</span>';
  html += '<span id="diagCopy" class="t-accent t-sm" style="margin-left:auto;cursor:pointer">复制</span>';
  html += '<span id="diagToLog" class="t-dim t-sm" style="cursor:pointer">输出到 logcat</span>';
  html += '<span id="diagClear" class="t-dim t-sm" style="cursor:pointer">清空</span>';
  html += '</div>';

  if (!list.length) {
    html += '<div class="t-dim t-sm" style="padding:var(--sp-4) 0">还没有日志</div>';
  } else {
    for (const r of list) {
      const col = r.lv === "E" ? "var(--up)" : (r.lv === "W" ? "var(--accent)" : "var(--fg2)");
      html += '<div style="padding:5px 0;border-top:1px solid var(--line);font-size:var(--fs-xs)">';
      html += '<span class="t-dim" style="font-variant-numeric:tabular-nums">' + r.t + '</span> ';
      html += '<span style="color:' + col + '">' + r.lv + '</span> ';
      html += '<span class="t-fg2">' + r.m + '</span>';
      if (r.x) html += '<div class="t-dim" style="margin-top:2px;opacity:.8">' + r.x + '</div>';
      html += '</div>';
    }
  }
  html += '</div>';
  return html;
}
/* ---- 历史收益率（账户 vs 大盘） ---- */

/**
 * 用当前持仓回溯账户净值曲线。
 *
 * 算法：把每只基金的净值历史按持有份额加权加起来，
 * 得到「如果一直持有现在这套组合，账户每天值多少钱」。
 *
 * 注意这是「当前组合的回溯」，不是真实成交记录——
 * 中途加减仓会影响实际收益，但用来判断
 * 「我选的这些基金跑赢大盘了吗」是完全够用的。
 *
 * 归一化到 100 起，和沪深300 放在同一坐标系里比较。
 * 不同基金净值日期不完全一致（QDII 会滞后两天），
 * 统一按日期并集、缺失用前值填充，避免曲线断点。
 */
async function buildPerfCurve(days) {
  const N = days || 60;
  const hs = S.holdings.filter(h => S.full[h.code] && S.full[h.code].trend);
  if (!hs.length) return null;

  // 基准：沪深300
  let bench = null;
  try { bench = await api.indexHistory("sh000300", N + 10); } catch (e) { bench = null; }

  // 收集所有出现过的日期，取最近 N 个交易日
  const dateSet = Object.create(null);
  for (const h of hs) {
    for (const t of S.full[h.code].trend.slice(-(N + 20))) dateSet[t.date] = 1;
  }
  const dates = Object.keys(dateSet).sort();
  const use = dates.slice(-N);
  if (use.length < 5) return null;

  /*
   * 每只基金：净值映射 + 「某天持有多少份额」。
   *
   * 份额不再是拿当前值一刀切，而是逐日还原：
   *   有流水 → txLog.sharesAt()，加仓/减仓/清仓都反映得出来
   *   没流水 → 退化成「从起始日起一直持有现在的份额」
   * 起始日的取法：优先用户填的买入日，其次加入日期，
   * 最后按成本价在净值曲线上反推一个大概的日子。
   */
  const funds = hs.map(h => {
    const m = Object.create(null);
    for (const t of S.full[h.code].trend) m[t.date] = t.nav;
    const fixed = +h.shares || 0;
    const from = txLog.firstDate(h.code) || inferStartDate(h, S.full[h.code]);
    return {
      code: h.code,
      m,
      from,
      fixed,
      shareAt(d) {
        if (txLog.has(this.code)) return txLog.sharesAt(this.code, d) || 0;
        return (this.from && d >= this.from) ? this.fixed : 0;
      },
    };
  });

  /*
   * 重建每日市值 + 当日净流入。
   * 缺失净值用前值填充（不同基金的净值日期不完全一致，QDII 会滞后）。
   */
  const rows = [];
  const lastNav = Object.create(null);
  let prevShares = null;
  for (const d of use) {
    const shares = Object.create(null);
    let mv = 0;
    for (const f of funds) {
      const nav = f.m[d];
      if (nav != null) lastNav[f.code] = nav;
      const sh = f.shareAt(d);
      shares[f.code] = sh;
      const px = lastNav[f.code];
      if (px != null && sh > 0) mv += px * sh;
    }

    // 净流入 = Σ(份额变化 × 当日净值)。买入为正、卖出为负。
    let flow = 0;
    if (prevShares) {
      for (const f of funds) {
        const px = lastNav[f.code];
        if (px == null) continue;
        const ds = (shares[f.code] || 0) - (prevShares[f.code] || 0);
        if (ds) flow += px * ds;
      }
    }
    rows.push({ date: d, mv, flow });
    prevShares = shares;
  }

  // 跳过「一只都还没买」的那几天，曲线从真正开始持仓那天算起
  let s0 = 0;
  while (s0 < rows.length && !(rows[s0].mv > 0)) s0++;
  const seq = rows.slice(s0);
  if (seq.length < 2) return null;

  /*
   * 时间加权收益率（TWR）。
   *
   *   r(t) = (今日市值 - 昨日市值 - 今日净流入) / 昨日市值
   *
   * 减掉净流入这一步是关键：没有它，用户加仓当天市值凭空变大，
   * 曲线会当成「赚了」往上一跳 —— 这正是原来那个 bug 的另一种形态。
   */
  const acct = [100];
  for (let i = 1; i < seq.length; i++) {
    const base = seq[i - 1].mv;
    const prev = acct[acct.length - 1];
    if (!(base > 0)) { acct.push(prev); continue; }
    const r = (seq[i].mv - base - seq[i].flow) / base;
    acct.push(prev * (1 + r));
  }

  const seqDates = seq.map(r => r.date);

  // 基准映射：对齐到实际使用的日期区间
  const bmap = Object.create(null);
  if (bench) for (const b of bench) bmap[b.date] = b.close;
  let blast = null;
  const bser = seqDates.map(d => {
    const v = bmap[d];
    if (v != null) blast = v;
    return blast;
  });
  const b0 = bser[0] || 1;

  const acctLast = acct[acct.length - 1];
  return {
    dates: seqDates,
    acct: acct,                       // 已经是 100 起的净值化序列
    bench: bser.map(v => v == null ? null : v / b0 * 100),
    acctEnd: seq[seq.length - 1].mv,  // 期末真实市值
    acctPct: acctLast - 100,
    benchPct: bser[bser.length - 1] ? (bser[bser.length - 1] / b0 - 1) * 100 : null,
    startDate: seqDates[0],
    // 前几天因为「还没持仓」被砍掉了，界面据此说明区间为何比选定的短
    skipped: s0,
  };
}

/**
 * 没有买入日、也没有流水时，从成本价反推一个大概的买入日。
 *
 * 思路：在净值曲线上从后往前找第一个「单位净值 ≤ 成本价」的日子 ——
 * 那天买入才可能刚好落在成本价上。
 *
 * 这是**推测**，会有偏差；但比原来的「假设他从头就持有」准得多。
 * 用户在表单里填了买入日就会用真的。
 */
function inferStartDate(h, full) {
  const cost = +h.costNav || 0;
  const tr = full && full.trend;
  if (tr && tr.length && cost > 0) {
    for (let k = tr.length - 1; k >= 0; k--) {
      if (tr[k].nav <= cost) return tr[k].date;
    }
  }
  // 兜底：最多回溯 60 个交易日
  if (tr && tr.length) return tr[Math.max(0, tr.length - 60)].date;
  return null;
}

/**
 * 画双线对比图（纯 SVG，不引图表库）。
 *
 * 用 viewBox 等比缩放，宽度靠 CSS 撑满，
 * 任何分辨率下都清晰，缩放时零重排。
 */
function perfChart(curve) {
  if (!curve || curve.dates.length < 2) {
    return "<div class=\"empty\" style=\"padding:30px\">数据不足，暂无法生成曲线</div>";
  }

  const W = 320, H = 150, PAD = 6;
  const n = curve.dates.length;
  const all = curve.acct.concat(curve.bench.filter(v => v != null));
  let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
  if (!isFinite(lo) || !isFinite(hi)) { lo = 95; hi = 105; }
  if (hi - lo < 2) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const x = i => PAD + (W - PAD * 2) * (n === 1 ? 0 : i / (n - 1));
  const y = v => H - PAD - (H - PAD * 2) * ((v - lo) / (hi - lo));

  const path = arr => {
    let d = "", pen = false;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1) + " ";
      pen = true;
    }
    return d.trim();
  };

  const baseY = y(100);

  return "<svg viewBox=\"0 0 " + W + " " + H + "\" preserveAspectRatio=\"none\" style=\"width:100%;height:" + H + "px;display:block\">" +
    "<line x1=\"" + PAD + "\" y1=\"" + baseY.toFixed(1) + "\" x2=\"" + (W - PAD) + "\" y2=\"" + baseY.toFixed(1) + "\" stroke=\"var(--line)\" stroke-width=\"1\" stroke-dasharray=\"3 3\"/>" +
    "<path d=\"" + path(curve.bench) + "\" fill=\"none\" stroke=\"var(--fg2)\" stroke-width=\"1.6\" stroke-linejoin=\"round\" opacity=\".75\"/>" +
    "<path d=\"" + path(curve.acct) + "\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2.2\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>" +
    "</svg>";
}

/**
 * 历史总资产涨跌页。
 *
 * 原来这里只给一个账户收益率百分比。但点进来的动机其实是
 * 「我这段时间到底赚了亏了多少钱」，百分比答不了这个问题。
 * 所以主数字换成金额，百分比退到副行。
 */
function viewPerf() {
  const c = S.perfCurve;
  const days = S.perfDays || 60;

  /* 当前总资产：与资产页同一口径（份额 × 最新净值） */
  let totalNow = 0;
  for (const h of S.holdings) totalNow += holdCalc(h, S.full[h.code]).value;

  /*
   * 把净值化曲线还原成真金白银。
   *
   * buildPerfCurve 给的是以 100 为基准的序列，用它反推期初市值即可，
   * 不必额外存一份历史快照：
   *     期初 = 当前总资产 × 期初指数 / 期末指数
   */
  let startValue = totalNow, changeMoney = 0, hasCurve = false;
  if (c && c.acct && c.acct.length > 1) {
    const last = c.acct[c.acct.length - 1];
    const first = c.acct[0];
    if (last) {
      startValue = totalNow * first / last;
      changeMoney = totalNow - startValue;
      hasCurve = true;
    }
  }
  const changeColor = !hasCurve ? "var(--dim)"
    : (changeMoney > 0 ? "var(--up)" : (changeMoney < 0 ? "var(--down)" : "var(--fg)"));

  let html = "<div class=\"pcard\" style=\"margin:12px 12px 0;padding:16px\">";
  html += "<div style=\"display:flex;align-items:baseline;gap:10px\">";
  html += "<div class=\"big perf-num\" style=\"font-size:var(--fs-3xl);font-weight:700;color:"
    + changeColor + "\">" + (hasCurve ? moneyFull(changeMoney) : "--") + "</div>";
  html += "<div style=\"font-size:var(--fs-sm);color:var(--dim)\">近 " + days + " 个交易日</div>";
  html += "</div>";

  /* 期初 → 期末，把「钱」这条线也交代清楚 */
  if (hasCurve) {
    html += "<div style=\"margin-top:10px;display:flex;align-items:center;gap:8px;" +
      "font-size:var(--fs-sm);color:var(--fg2)\">";
    html += "<span>" + moneyFull0(startValue) + "</span>";
    html += "<span style=\"color:var(--dim)\">→</span>";
    html += "<span class=\"" + pctCls(changeMoney) + "\" style=\"font-weight:600\">" +
      moneyFull0(totalNow) + "</span>";
    html += "<span class=\"" + pctCls(c.acctPct) + "\" style=\"margin-left:auto\">" +
      pctTxt(c.acctPct) + "</span>";
    html += "</div>";
  }

  html += "<div style=\"margin-top:8px;font-size:var(--fs-sm);color:var(--fg2)\">同期沪深300 ";
  if (c && c.benchPct != null) {
    html += "<span class=\"" + pctCls(c.benchPct) + "\">" + pctTxt(c.benchPct) + "</span>";
    html += "<span style=\"color:var(--dim)\"> · 超额 <b class=\"" +
      pctCls(c.acctPct - c.benchPct) + "\">" + pctTxt(c.acctPct - c.benchPct) + "</b></span>";
  } else {
    html += "--";
  }
  html += "</div></div>";

  // 区间切换
  html += "<div class=\"sectabs\" style=\"padding:0 12px\">";
  for (const d of [20, 60, 120]) {
    html += "<button data-perfd=\"" + d + "\" class=\"" + (days === d ? "on" : "") +
      "\" style=\"flex:1\">" + d + "日</button>";
  }
  html += "</div>";

  html += "<div style=\"background:var(--card);margin:10px 12px;border-radius:14px;" +
    "padding:12px 8px 4px;overflow:hidden\">";
  html += S.perfBusy
    ? "<div class=\"empty\" style=\"height:120px\">正在回溯…</div>"
    : perfChart(c);
  html += "<div style=\"display:flex;gap:14px;padding:8px 8px 10px;font-size:var(--fs-xs);color:var(--dim)\">" +
    "<span><i style=\"display:inline-block;width:9px;height:2.5px;background:var(--accent);border-radius:2px;vertical-align:middle\"></i> 我的账户</span>" +
    "<span><i style=\"display:inline-block;width:9px;height:2.5px;background:var(--fg2);border-radius:2px;vertical-align:middle\"></i> 沪深300</span>" +
    "</div></div>";

  // 逐只贡献
  const hs = S.holdings.filter(h => S.full[h.code] && S.full[h.code].trend);
  if (hs.length) {
    html += "<div class=\"colhead\"><div class=\"c0\">基金</div>" +
      "<div class=\"c1\">占比</div><div class=\"c2\">" + days + "日</div></div>";
    let totVal = 0;
    for (const h of hs) totVal += (S.nav[h.code] ? S.nav[h.code].nav : 0) * h.shares;
    for (const h of hs) {
      const tr = S.full[h.code].trend;
      const cur = tr[tr.length - 1].nav;
      const from = tr[Math.max(0, tr.length - 1 - days)].nav;
      const pct = from ? (cur / from - 1) * 100 : 0;
      const val = (S.nav[h.code] ? S.nav[h.code].nav : cur) * h.shares;
      const w = totVal ? val / totVal * 100 : 0;
      html += "<div class=\"fund\">" +
        "<div class=\"c0\"><div class=\"nm\">" + (h.name || h.code) + "</div></div>" +
        "<div class=\"c1\">" + fmt(w, 1) + "%</div>" +
        "<div class=\"c2 " + pctCls(pct) + "\">" + pctTxt(pct).replace("%", "") + "</div>" +
        "</div>";
    }
  } else {
    html += "<div class=\"empty\">还没有持仓数据</div>";
  }

  html += "<div style=\"padding:14px 16px 24px;text-align:center;" +
    "font-size:var(--fs-xs);color:var(--dim);line-height:1.6\">" +
    "按当前持仓份额回溯，非真实成交记录<br>中途加减仓会与实际收益有差异</div>";
  return html;
}

/** 加载历史收益率曲线 */
async function loadPerf(days) {
  S.perfDays = days || S.perfDays || 60;
  S.perfBusy = true;
  render();
  try {
    S.perfCurve = await buildPerfCurve(S.perfDays);
  } catch (e) {
    S.perfCurve = null;
  }
  S.perfBusy = false;
  render();
}

/* ---- 底部固定指数条 ---- */
function renderIdxbar() {
  const bar = document.getElementById('idxbar');
  const roll = document.getElementById('idxroll');
  if (!bar || !roll) return;
  if (!S.indices.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';

  const one = S.indices.map(q =>
    '<span class="grp"><b>' + q.name + '</b>'
    + '<span class="' + pctCls(q.change) + '">' + fmt(q.price) + '</span>'
    + '<span class="' + pctCls(q.change) + '">' + pctTxt(q.pct) + '</span></span>'
  ).join('');

  /*
   * 内容放两份，CSS 动画整体左移 50% 就形成无缝循环。
   * 只在内容真的变了才重建 DOM —— 每 30 秒一次的指数刷新
   * 如果都重写 innerHTML，动画会被打断、从接缝处跳一下。
   */
  if (roll.dataset.sig !== one) {
    roll.dataset.sig = one;
    roll.innerHTML = one + one;
  }

  /*
   * 时长按内容宽度算，保证**线速度恒定**。
   * 写死时长的话，指数一多就跑得飞快、一少又慢得发困。
   *
   * 48px/s 是折中：比人眼扫读一行字略慢，余光里能看清涨跌，
   * 又不至于一直抢注意力。
   */
  requestAnimationFrame(() => {
    const w = roll.scrollWidth / 2;      // 一份的宽度
    if (!w) return;
    roll.style.animationDuration = Math.max(14, w / 48) + 's';
  });
}

/* ---- 自选 ---- */
function viewWatch() {
  if (!S.watch.length) {
    return `<div class="empty">还没有自选基金
      <br>用「添加基金」搜索添加</div>`;
  }
  let html = `<div class="colhead">
    <div class="c0">基金名称</div>
    <div class="c1">今日</div>
    <div class="c2">净值</div>
  </div>`;
  for (const w of S.watch) {
    const q = S.nav[w.code];
    const tp = todayPctOf(w.code);
    html += `<div class="fund" data-code="${w.code}">
      <div class="c0">
        <div class="nm">${w.name || w.code}</div>
        <div class="amt">${w.code}${q ? ' · ' + q.date : ''}</div>
      </div>
      <div class="c1 ${pctCls(tp || 0)}">${pctTxt(tp).replace('%', '')}</div>
      <div class="c2">${q ? fmt(q.nav, 4) : '--'}</div>
    </div>`;
  }
  return html;
}

/* ---- 行情 ---- */
function viewMarket() {
  const segs = [
    { id: 'index',    name: '大盘' },
    { id: 'industry', name: '板块' },
    { id: 'concept',  name: '涨跌分布' },
    { id: 'global',   name: '全球指数' },
  ];
  let html = '<div class="sectabs">'
    + segs.map(x => '<button class="' + (S.mktSeg === x.id ? 'on' : '') + '"'
      + ' data-seg="' + x.id + '">' + x.name + '</button>').join('')
    + '</div>';

  if (S.mktSeg === 'index') return html + viewMarketIndex();
  if (S.mktSeg === 'global') return html + viewGlobalIndices();
  if (S.mktSeg === 'concept') return html + viewBreadth();
  return html + viewSectors();
}

/**
 * 大盘：A 股宽基指数 + 全市场概览。
 *
 * 这个函数原来只有调用、没有定义——而 S.mktSeg 的默认值就是 'index'，
 * 所以「行情」tab 一打开就抛 ReferenceError（viewMarketIndex is not defined），
 * 异常发生在 renderNow 里那句 mainEl.innerHTML 赋值上，
 * 标题和底部高亮已经更新了，正文却停在上一个页面。
 * 表现就是：点「行情」，顶栏写着行情，屏幕里还是资产页。
 */
function viewMarketIndex() {
  const grp = GLOBAL_GROUPS[0];          // A 股 · 宽基
  const rows = (grp ? grp.items : [])
    .map(it => S.gidx[it.code]).filter(Boolean);

  // 一条都没到：先给骨架屏，别让用户对着空白等
  if (!rows.length) return viewMarketSummary() + skeletonList(9, !S.heat);

  let html = viewMarketSummary() + staleBar();
  html += `<div style="padding:12px 16px 4px;color:var(--fg2);
    font-size:var(--fs-sm);font-weight:600;background:var(--bg)">${grp.title}</div>`;

  for (const q of rows) {
    const ev = evaInfo(valuationByCode(q.code));
    html += `<div class="fund">
      <div class="c0">
        <div class="nm">${q.name}</div>
        <div class="amt">${ev
          ? 'PE ' + fmt(ev.pe, 1) + ' · <span class="' + ev.cls + '">'
            + ev.label + ' ' + ev.pctText + '</span>'
          : (q.time || '')}</div>
      </div>
      <div class="c1 ${pctCls(q.change)}">${moneyTxt(q.change)}</div>
      <div class="c2 ${pctCls(q.pct)}">${pctTxt(q.pct)}</div>
    </div>`;
  }
  html += '<div class="newsend">指数行情为当日实时，估值来自蛋卷</div>';
  return html;
}

/** 大盘概览条：涨跌家数 + 成交额 + 更新时间 */
function viewMarketSummary() {
  const h = S.heat;
  if (!h) return '';
  const sm = h.summary || {};
  const total = (sm.advance || 0) + (sm.flat || 0) + (sm.decline || 0) || 1;
  const ap = (sm.advance || 0) / total * 100;
  const dp = (sm.decline || 0) / total * 100;

  // 成交额自动换算：过万亿用「万亿」，否则用「亿」
  const tn = sm.turnover || 0;
  const amtTxt = tn >= 1e12 ? fmt(tn / 1e12, 2) + ' 万亿'
    : fmt(tn / 1e8, 0) + ' 亿';

  return '<div class="mktbar">'
    + '<div class="mktgrid">'
    + '<div class="mi"><b class="up">' + (sm.advance || 0) + '</b><span>上涨</span></div>'
    + '<div class="mi"><b>' + (sm.flat || 0) + '</b><span>平盘</span></div>'
    + '<div class="mi"><b class="down">' + (sm.decline || 0) + '</b><span>下跌</span></div>'
    + '<div class="mi"><b>' + amtTxt + '</b><span>成交额</span></div>'
    + '</div>'
    + '<div class="breadth"><i class="u" style="width:' + ap.toFixed(1) + '%"></i>'
    + '<i class="d" style="width:' + dp.toFixed(1) + '%"></i></div>'
    + '<div class="mktfoot">全市场 ' + (h.stockCount || 0) + ' 只 · '
    + (h.boardCount || 0) + ' 个板块 · 更新 ' + (S.heatAt || '--') + '</div>'
    + '</div>';
}

/** 全球指数：按市场分组 */
function viewGlobalIndices() {
  if (!S.gidx || !Object.keys(S.gidx).length) {
    return `<div class="empty">全球指数加载中…</div>`;
  }

  let html = '';
  // A 股宽基已经由「大盘」分段负责，这里跳过，避免两个分段内容重复
  for (const g of GLOBAL_GROUPS.slice(1)) {
    const rows = g.items.map(it => S.gidx[it.code]).filter(Boolean);
    if (!rows.length) continue;

    html += `<div style="padding:12px 16px 4px;color:var(--fg2);
      font-size:var(--fs-sm);font-weight:600;background:var(--bg)">${g.title}</div>`;

    for (const q of rows) {
      // 估值按指数代码匹配：沪深300(sh000300) -> 蛋卷的 SH000300
      const ev = evaInfo(valuationByCode(q.code));
      html += `<div class="fund">
        <div class="c0">
          <div class="nm">${q.name}</div>
          <div class="amt">${ev
            ? 'PE ' + fmt(ev.pe, 1) + ' · <span class="' + ev.cls + '">'
              + ev.label + ' ' + ev.pctText + '</span>'
            : (q.time || '')}</div>
        </div>
        <div class="c1 ${pctCls(q.change)}">${moneyTxt(q.change)}</div>
        <div class="c2 ${pctCls(q.pct)}">${pctTxt(q.pct)}</div>
      </div>`;
    }
  }
  return html;
}

/**
 * 骨架屏：数据未到时先占位。
 * 拼多多的经验是「结构先出现、内容后填充」，
 * 用户感知的等待会短很多，也不会因内容突然插入而跳动。
 */
function skeletonList(rows, withSummary) {
  let h = '';
  if (withSummary) {
    h += '<div class="mktbar"><div class="mktgrid">';
    for (let i = 0; i < 4; i++) {
      h += '<div class="mi">'
        + '<span class="skel" style="width:46px;height:16px"></span>'
        + '<span class="skel" style="width:28px;height:10px;margin-top:5px"></span>'
        + '</div>';
    }
    h += '</div></div>';
  }
  for (let i = 0; i < (rows || 8); i++) {
    h += '<div class="skelrow">'
      + '<div class="l"><div class="skel skelnm"></div>'
      + '<div class="skel skelamt"></div></div>'
      + '<div class="skel skelnum"></div></div>';
  }
  return h;
}

/** 数据来自缓存的过期提示条 */
function staleBar() {
  if (!S.heatStale) return '';
  return '<div class="stalebar">'
    + '<span>显示的是缓存数据（' + cache.ageText(S.heatAge) + '）</span>'
    + '<button id="staleRefresh">刷新</button></div>';
}

/** 板块排行：数据来自 map.findfin.app 全市场热力图 */
const SECTOR_SORTS = [
  { id: 'pct',    name: '涨跌幅' },
  { id: 'pctAsc', name: '跌幅' },
  { id: 'cap',    name: '市值' },
  { id: 'count',  name: '成分股' },
];

function sectorSorted() {
  const list = ((S.heat && S.heat.boards) || []).slice();
  const k = S.sectorSort || 'pct';
  if (k === 'pct') list.sort((a, b) => b.pct - a.pct);
  else if (k === 'pctAsc') list.sort((a, b) => a.pct - b.pct);
  else if (k === 'cap') list.sort((a, b) => b.value - a.value);
  else if (k === 'count') list.sort((a, b) => b.stockCount - a.stockCount);
  else list.sort((a, b) => b.pct - a.pct);
  return list;
}

/**
 * 估值匹配：把行情板块对到指数估值上。
 *
 * 两条路径：
 *   1. 指数代码直接对应（沪深300 -> SH000300）
 *   2. 名称包含匹配（银行 -> 中证银行，证券 -> 证券公司）
 * 匹配不到就返回 null，界面显示「--」，绝不编数据。
 */
/**
 * 板块名 -> 指数估值名的映射。
 *
 * 蛋卷只覆盖 63 个有对应指数产品的标的，
 * 所以这里只填「确实存在对应指数」的板块，
 * 找不到对应的就显示 --，不硬凑。
 */
const VALUATION_ALIAS = {
  // 一级行业 -> 对应指数
  '电子': '中证电子',
  '银行': '中证银行',
  '医药生物': '全指医药',
  '非银金融': '证券公司',
  '通信': '5G通讯',
  '计算机': '全指信息',
  '传媒': '中证传媒',
  '国防军工': '中证军工',
  '煤炭': '中证煤炭',
  '食品饮料': '国证食品',
  '电力设备': '新能源车',
  '房地产': '国证地产',
  '环保': '中证环保',
  // 概念 / 细分
  '证券': '证券公司',
  '白酒': '中证白酒',
  '医疗': '中证医疗',
  '医药': '全指医药',
  '军工': '中证军工',
  '半导体': '中证电子',
  '新能源车': '新能源车',
  'CPO通信': '5G通讯',
  '红利': '中证红利',
  '银行Ⅱ': '中证银行',
  '科创50': '科创50',
};

/** 按指数代码取估值（用于全球指数） */
function valuationByCode(code) {
  if (!S.idxVal || !code) return null;
  const key = String(code).toUpperCase();
  return S.idxVal.byCode[key] || null;
}

/** 按板块名取估值（用于行业 / 概念板块） */
function valuationByName(name) {
  if (!S.idxVal || !name) return null;
  const byName = S.idxVal.byName;
  const alias = VALUATION_ALIAS[name];
  if (alias && byName[alias]) return byName[alias];
  if (byName[name]) return byName[name];
  // 包含匹配：板块名出现在指数名里，或反之
  for (const k in byName) {
    if (k.indexOf(name) >= 0 || name.indexOf(k) >= 0) return byName[k];
  }
  return null;
}

/** 估值档位文案与配色。PE 缺失或为 0 视为无数据，不编造档位 */
function evaInfo(rec) {
  if (!rec) return null;
  if (rec.pe == null || !(rec.pe > 0)) return null;
  const pct = rec.pePct;
  let label = '', cls = '';
  if (rec.eva === 'low') { label = '低估'; cls = 'up'; }
  else if (rec.eva === 'high') { label = '高估'; cls = 'down'; }
  else { label = '适中'; cls = ''; }
  return {
    label, cls,
    pe: rec.pe,
    pct,
    pctText: pct == null ? '--' : fmt(pct * 100, 0) + '%',
    date: rec.date,
  };
}

/** 估值单元格：PE + 历史分位，一行说不清就不显示 */
function valuationCell(rec) {
  const v = evaInfo(rec);
  if (!v) return '<span class="t-dim">--</span>';
  return '<span>' + (v.pe != null ? fmt(v.pe, 1) : '--') + '</span>'
    + '<small class="' + v.cls + '">' + v.label + ' · ' + v.pctText + '</small>';
}

/**
 * 估值单元格。
 * 优先用指数估值（带历史分位，信息量最大）；
 * 没有对应指数时退回东财的板块 PE；两者都没有就显示 --。
 */
function peCell(b) {
  const rec = valuationByName(b.name);
  if (rec) return valuationCell(rec);

  const v = S.valuation && S.valuation[b.name];
  if (!v || v.pe == null) return '<span class="t-dim">--</span>';
  if (v.pe <= 0) return '<span class="t-dim">亏损</span>';
  return '<span>' + fmt(v.pe, 1) + '</span>';
}

function viewSectors() {
  // 没数据时先画骨架屏；确实失败了就换成带重试的提示
  if (!S.heat) return heatPending();

  const list = sectorSorted();
  const k = S.sectorSort || 'pct';

  let html = staleBar();
  html += viewMarketSummary();

  html += '<div class="sortbar">'
    + SECTOR_SORTS.map(x => '<button class="' + (k === x.id ? 'on' : '') + '"'
      + ' data-sort="' + x.id + '">' + x.name + '</button>').join('')
    + '</div>';

  html += '<div class="colhead"><div class="c0">板块</div>'
    + '<div class="c1">涨跌幅</div><div class="c2">估值</div></div>';

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const rank = i + 1;
    html += '<div class="srow" data-board="' + encodeURIComponent(b.name) + '">'
      + '<div class="rank' + (rank <= 3 ? ' top' : '') + '">' + rank + '</div>'
      + '<div class="c0"><div class="nm">' + b.name + '</div>'
      + '<div class="amt">' + b.stockCount + ' 只 · 涨' + b.up + ' 跌' + b.down
      + '</div></div>'
      + '<div class="c1 ' + pctCls(b.pct) + '">' + pctTxt(b.pct) + '</div>'
      + '<div class="c2">' + peCell(b) + '</div>'
      + '</div>';
  }

  html += '<div class="secline"><span>共 ' + list.length + ' 个板块</span>'
    + '<span>点开看成分股</span></div>';
  return html;
}

/** 涨跌分布：按涨跌区间统计全部成分股 */
function viewBreadth() {
  if (!S.heat) return heatPending();

  const buckets = [
    { label: '涨超 9%', min: 9, cls: 'up' },
    { label: '涨 5~9%', min: 5, cls: 'up' },
    { label: '涨 2~5%', min: 2, cls: 'up' },
    { label: '涨 0~2%', min: 0.0001, cls: 'up' },
    { label: '平盘', min: -0.0001, cls: '' },
    { label: '跌 0~2%', min: -2, cls: 'down' },
    { label: '跌 2~5%', min: -5, cls: 'down' },
    { label: '跌 5~9%', min: -9, cls: 'down' },
    { label: '跌超 9%', min: -1000, cls: 'down' },
  ];
  const counts = buckets.map(() => 0);
  const all = [];
  for (const b of (S.heat.boards || [])) {
    for (const st of (b.stocks || [])) {
      const pc = st.changePct || 0;
      all.push({ ...st, board: b.name });
      for (let i = 0; i < buckets.length; i++) {
        if (pc >= buckets[i].min) { counts[i]++; break; }
      }
    }
  }
  const maxC = Math.max.apply(null, counts.concat([1]));

  let html = viewMarketSummary();
  html += '<div style="background:var(--card);padding:14px 16px">'
    + '<div style="color:var(--dim);font-size:var(--fs-sm);margin-bottom:10px">'
    + '全市场涨跌分布 · ' + all.length + ' 只</div>';
  for (let i = 0; i < buckets.length; i++) {
    html += '<div class="brow">'
      + '<span class="bl">' + buckets[i].label + '</span>'
      + '<span class="bbar"><i class="' + buckets[i].cls + '" style="width:'
      + (counts[i] / maxC * 100).toFixed(1) + '%"></i></span>'
      + '<span class="bc ' + buckets[i].cls + '">' + counts[i] + '</span>'
      + '</div>';
  }
  html += '</div>';

  all.sort((x, y) => (y.changePct || 0) - (x.changePct || 0));
  const top = all.slice(0, 6);
  const bot = all.slice(-6).reverse();

  const stockRow = st =>
    '<div class="kv"><span class="k">' + st.name
    + ' <span class="t-dim t-xs">' + st.board + '</span></span>'
    + '<span class="v ' + pctCls(st.changePct) + '">'
    + pctTxt(st.changePct) + '</span></div>';

  html += '<div class="pcard">'
    + '<div class="pcard-cap">领涨</div>'
    + top.map(stockRow).join('') + '</div>';
  html += '<div class="pcard">'
    + '<div class="pcard-cap">领跌</div>'
    + bot.map(stockRow).join('') + '</div>';

  return html;
}

/* ---- 板块情绪 ----
 *
 * 主数据：同花顺官方板块热榜（概念 / 行业各 20 个）
 *   - 热度是真实成交量级，每天都有，字段稳定
 *   - 带涨停家数、连榜天数、排名变化、关联 ETF
 *
 * 副数据：第三方聚合的「宝妈指数」
 *   - 只有部分板块有真实热度源，其余是占位值 5.0
 *   - 因此只展示 data_valid=true 的，其余明确标注不参与排行
 */
const MOOD_TABS = [
  { id: 'concept',  name: '概念热榜' },
  { id: 'industry', name: '行业热榜' },
  { id: 'mom',      name: '宝妈指数' },
];

const MOOD_SORTS = [
  { id: 'heat',   name: '热度' },
  { id: 'pct',    name: '涨跌幅' },
  { id: 'chg',    name: '排名变化' },
];

/** 热榜排序 */
function hotSorted() {
  const list = ((S.hot && S.hot[S.hotTab || 'concept']) || []).slice();
  const k = S.hotSort || 'heat';
  if (k === 'pct') list.sort((a, b) => b.pct - a.pct);
  else if (k === 'chg') list.sort((a, b) => b.rankChg - a.rankChg);
  else list.sort((a, b) => b.heat - a.heat);
  return list;
}

function viewMood() {
  const tab = S.moodTab || 'concept';

  let html = '<div class="sectabs">'
    + MOOD_TABS.map(x => '<button class="' + (tab === x.id ? 'on' : '') + '"'
      + ' data-mood-tab="' + x.id + '">' + x.name + '</button>').join('')
    + '</div>';

  if (tab === 'mom') return html + viewMomIndex();
  return html + viewHotRank(tab);
}

/** 同花顺热榜 */
function viewHotRank(type) {
  // type 就是 concept / industry，直接按它取数据（不要读不存在的 hotTab）
  S.hotTab = type;
  const list = hotSorted();
  if (!list.length) {
    if (S.hotLoading) return '<div class="empty">热榜加载中…</div>';
    return '<div class="empty">热榜暂时不可用'
      + '<br><br><span id="moodRetry" class="t-accent">点此重试</span></div>';
  }

  const k = S.hotSort || 'heat';

  let html = '<div class="secsum">'
    + '<span>' + (type === 'industry' ? '行业' : '概念') + '热榜 <b>'
    + list.length + '</b> 个</span>'
    + '<span>数据来自同花顺官方</span>'
    + '<span>更新 ' + (S.hotAt || '--') + '</span>'
    + '</div>';

  html += '<div class="sortbar">'
    + MOOD_SORTS.map(x => '<button class="' + (k === x.id ? 'on' : '') + '"'
      + ' data-hot-sort="' + x.id + '">' + x.name + '</button>').join('')
    + '</div>';

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const rank = i + 1;
    const chg = p.rankChg;
    const chgTxt = chg > 0 ? '↑' + chg : (chg < 0 ? '↓' + Math.abs(chg) : '—');

    // 热度条：按当前列表最大值归一化
    const maxHeat = Math.max.apply(null, list.map(x => x.heat).concat([1]));
    const barW = Math.max(4, p.heat / maxHeat * 100);

    html += '<div class="hotrow" data-hot-name="' + encodeURIComponent(p.name) + '">'
      + '<div class="rank' + (rank <= 3 ? ' top' : '') + '">' + rank + '</div>'
      + '<div class="hbody">'
      + '<div class="hline">'
      + '<span class="hname">' + p.name + '</span>'
      + '<span class="' + pctCls(p.pct) + ' hpct">' + pctTxt(p.pct) + '</span>'
      + '</div>'
      + '<div class="hbar"><i style="width:' + barW.toFixed(1) + '%"></i></div>'
      + '<div class="hfoot">'
      + '<span>热度 ' + fmt(p.heat / 10000, 1) + '万</span>'
      + '<span class="' + (chg > 0 ? 'up' : (chg < 0 ? 'down' : '')) + '">'
      + chgTxt + '</span>'
      + (p.tag ? '<span>' + p.tag + '</span>' : '')
      + (p.hotTag ? '<span>' + p.hotTag + '</span>' : '')
      + '</div>'
      + (p.etfName
        ? '<div class="hetf">ETF ' + p.etfName
          + (isFinite(p.etfPct)
            ? ' <span class="' + pctCls(p.etfPct) + '">'
              + pctTxt(p.etfPct) + '</span>' : '')
          + '</div>'
        : '')
      + '</div></div>';
  }
  return html;
}

/** 宝妈指数（第三方聚合，只展示有真实热度源的） */

/**
 * 市场温度卡：涨停 / 跌停 / 连板 / 炸板。
 *
 * 这几个数字组合起来比单看指数涨跌更能说明问题：
 * 指数涨但炸板率高，说明资金不敢拿；
 * 指数跌但涨停不少，说明有主线在做。
 */
function limitCard() {
  const L = S.limit;
  if (!L) return '';

  const total = L.upCount + L.downCount;
  const upRatio = total ? L.upCount / total : 0;
  const brokenRate = L.upCount ? L.broken / L.upCount : 0;

  // 温度：涨停占比为主，连板高度加成、炸板率扣分
  let temp = 30 + upRatio * 45;
  temp += Math.min(12, L.maxStreak * 3);
  temp -= brokenRate * 18;
  temp = Math.max(2, Math.min(98, temp));

  const color = temp >= 70 ? '#ef4444' : temp >= 52 ? '#f59e0b'
    : temp >= 35 ? '#22c55e' : '#64748b';
  const label = temp >= 70 ? '火热' : temp >= 52 ? '偏暖'
    : temp >= 35 ? '中性' : '偏冷';

  let ladder = '';
  for (let k = L.maxStreak; k >= 1; k--) {
    const n = L.ladder[k] || 0;
    if (!n) continue;
    ladder += "<span class=\"lbchip\">" + k + "板 <b>" + n + "</b></span>";
  }

  let h = "<div class=\"limcard\">";
  h += "<div class=\"limtop\"><span class=\"limlab\">市场温度</span>";
  h += "<span style=\"margin-left:auto;color:" + color + ";font-weight:700;font-size:var(--fs-sm)\">" + label + "</span></div>";
  h += "<div class=\"limrow\">";
  h += "<div class=\"limnum up\"><b>" + L.upCount + "</b><span>涨停</span></div>";
  h += "<div class=\"limnum down\"><b>" + L.downCount + "</b><span>跌停</span></div>";
  h += "<div class=\"limnum\"><b>" + L.maxStreak + "</b><span>最高连板</span></div>";
  h += "<div class=\"limnum\"><b>" + L.broken + "</b><span>炸板</span></div>";
  h += "</div>";
  h += "<div class=\"mbar\" style=\"margin-top:8px\"><i style=\"width:" + temp + "%;background:" + color + "\"></i></div>";
  if (ladder) h += "<div class=\"limladder\">" + ladder + "</div>";
  h += "</div>";
  return h;
}

function viewMomIndex() {
  const list = S.mood || [];
  if (!S.mood) return '<div class="empty">加载中…</div>';
  if (!list.length) {
    return '<div class="empty">暂无数据'
      + '<br><br><span id="moodRetry" class="t-accent">点此重试</span></div>';
  }

  const rising = list.filter(x => x.score >= 58).length;
  const falling = list.filter(x => x.score < 42).length;

  let html = limitCard();
  html += '<div class="secsum">'
    + '<span>覆盖 <b>' + list.length + '</b> 个板块</span>'
    + '<span class="up">升温 <b>' + rising + '</b></span>'
    + '<span class="down">降温 <b>' + falling + '</b></span>'
    + '</div>';

  const TOP = 12;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const rank = i + 1;
    const color = m.color || '#6b7280';
    const dim = i >= TOP;

    html += '<div class="momcard' + (dim ? ' mood-dim' : '') + '"'
      + ' data-mom-name="' + encodeURIComponent(m.name) + '">'
      + '<div class="mhead">'
      + '<span class="rank' + (rank <= 3 ? ' top' : '') + '">' + rank + '</span>'
      + '<span class="mname">' + m.name + '</span>'
      + '<span class="mchg ' + pctCls(m.pct) + '">'
      + (m.pct != null ? pctTxt(m.pct) : (m.heat != null ? '热 ' + fmt(m.heat, 0) : '--'))
      + '</span>'
      + '</div>'
      + '<div class="mscore">'
      + '<span style="font-size:var(--fs-2xl);font-weight:700;color:' + color + ';line-height:1">'
      + Math.round(m.score) + '</span>'
      + '<span class="t-dim t-xs">/100</span>'
      + '<span style="margin-left:auto;color:' + color + ';font-size:var(--fs-sm);font-weight:600">'
      + m.status + '</span></div>'
      + '<div class="mbar"><i style="width:' + Math.min(m.score, 100)
      + '%;background:' + color + '"></i></div>'
      + newsBlock(m.name, 3)
      + '</div>';
  }

  html += '<div class="momnote">情绪分由涨跌幅、涨跌家数、平台热度合算，'
    + '50 为中性。点标题可直接看正文。</div>';
  return html;
}

/** 情绪板块 -> 行情板块的估值 */
function matchBoard(name) {
  const boards = (S.heat && S.heat.boards) || [];
  if (!name) return null;
  let hit = boards.find(b => b.name === name);
  if (hit) return hit;
  hit = boards.find(b => name.indexOf(b.name) >= 0 || b.name.indexOf(name) >= 0);
  return hit || null;
}


/* ---- 资讯（多渠道） ---- */
const NEWS_SOURCES = [
  { id: 'sina', name: '新浪7x24' },
  { id: 'ths', name: '同花顺' },
  { id: 'em', name: '东财要闻' },
  { id: 'em-global', name: '国际' },
  { id: 'em-macro', name: '商品市场' },
];

/**
 * 资讯列表：全渠道混合流，不设来源切换。
 * 每条只标来源和时间的极简信息，正文在 App 内阅读层打开。
 */
/**
 * 资讯列表。
 *
 * 全渠道混合流，按时间倒序。每条只给「标题 + 来源 + 时间」，
 * 摘要一律不显示——快讯类摘要就是标题的重复，长文摘要又常常
 * 是正文前两句的机械截断，占地方还没信息量。
 */
function viewNews() {
  const all = S.news || [];

  if (S.newsLoading && !all.length) {
    return skeletonList(6, false);
  }
  if (S.newsErr && !all.length) {
    return '<div class="empty">' + S.newsErr
      + '<br><br><span id="newsRetry" class="t-accent">点此重试</span></div>';
  }
  if (!all.length) {
    return '<div class="empty">暂无资讯<br><span class="t-sm">下拉可刷新</span></div>';
  }

  let html = "";

  for (const n of all) {
    const t = n.title || "";
    if (!t) continue;

    html += '<div class="newsrow"'
      + ' data-article="' + encodeURIComponent(n.url || "") + '"'
      + ' data-title="' + encodeURIComponent(t) + '">'
      + '<div class="newstitle">' + t + '</div>'
      + '<div class="newsmeta">'
      + '<span class="newssrc">' + (n.media || "") + '</span>'
      + '<span class="newstime">' + (n.time || "") + '</span>'
      + '</div></div>';
  }

  html += '<div class="newsend">' + all.length + ' 条 · '
    + (S.newsOk || 0) + ' 个渠道整合</div>';
  return html;
}

/* ---- 资讯正文（App 内纯净阅读） ---- */
/**
 * 正文页。
 *
 * 内容是本地提取好的干净 HTML，直接塞进容器渲染，
 * 不再是「一个 WebView 打开原网页」——那样用户永远会觉得
 * 自己还在浏览器里。
 */
function viewArticle() {
  const a = S.article;

  if (!a || a.loading) {
    return '<div class="artwrap"><div class="skel" style="height:26px;width:78%;margin-bottom:14px"></div>'
      + '<div class="skel" style="height:14px;width:40%;margin-bottom:22px"></div>'
      + [92, 100, 88, 96, 60].map(w =>
          '<div class="skel" style="height:15px;width:' + w + '%;margin-bottom:11px"></div>'
        ).join('')
      + '</div>';
  }

  if (a.error) {
    return '<div class="empty">正文提取失败'
      + '<br><span class="t-sm">' + (a.error || "") + '</span>'
      + '<br><br><span id="artOpenWeb" class="t-accent">用浏览器打开</span>'
      + '<br><span id="artRetry" style="color:var(--accent);font-size:var(--fs-sm)">重试</span></div>';
  }

  let html = '<div class="artbar">'
    + '<span id="artBack" class="artback">‹ 返回</span>'
    + (a.media ? '<span class="artbar-src">' + a.media + '</span>' : '')
    + '</div>';
  html += '<div class="artwrap">';
  html += '<div class="arttitle">' + (a.title || "") + '</div>';

  const meta = [a.media, a.byline].filter(Boolean).join(" · ");
  if (meta) html += '<div class="artmeta">' + meta + '</div>';

  html += '<div class="artbody" id="artBody">' + (a.html || "") + '</div>';
  html += '</div>';

  html += '<div class="artfoot">已提取正文 · 原文链接已隐藏</div>';
  return html;
}

/**
 * 打开资讯原文。
 *
 * 优先用 App 内的阅读层（系统 WebView）直接渲染原页面：
 * 很多站点正文靠 JS 生成或做了防盗链，纯文本抓取只能拿到骨架。
 * 阅读层是真正的「App 内打开」，且注入 CSS 去掉登录/评论/广告。
 *
 * 只有在没有原生桥（例如浏览器里预览）时才退回文本提取。
 */
/* ---- 打开资讯原文 ----
 *
 * 优先交给原生阅读层：系统 WebView 全屏打开原页面，
 * 由自带内核执行 JS、加载图片，正文自然完整，且不离开 App。
 * 阅读层自带顶栏返回按钮，不依赖系统返回键。
 *
 * 只有在没有原生桥（例如在浏览器里预览）时，才退回文本提取。
 */
/**
 * 打开资讯正文。
 *
 * 全流程在 App 内：原生抓 HTML -> 本地解析提取 -> 直接渲染。
 * 不跳浏览器，也不再用 WebView 打开原网页。
 *
 * 有缓存：同一篇点第二次是瞬开的。
 */
async function openArticle(url, title) {
  if (!url) { toast("该条没有原文链接"); return; }

  // 缓存命中直接出，速度接近瞬时
  const ck = "art_" + url;
  const hit = cache.get(ck);
  if (hit && hit.val && hit.val.html) {
    S._playEnter = true;
    S.articleFrom = S.tab;
    nav.push();
    S.tab = "article";
    S.article = hit.val;
    syncBackState();
    render();
    return;
  }

  S._playEnter = true;
  S.articleFrom = S.tab;
  nav.push();
  S.tab = "article";
  S.article = { loading: true, title: title || "", url };
  syncBackState();
  render();

  await loadArticle(url, title);
}

/** 真正去抓取并提取。失败会落到错误态，可重试。 */
async function loadArticle(url, title) {
  try {
    const a = await fetchArticle(url);
    if (!a || !a.html || a.html.length < 40) {
      throw new Error("正文为空");
    }
    a.title = a.title || title || "";
    S.article = a;
    // 正文不长，缓存 6 小时足够，也不占多少空间
    cache.set("art_" + url, a, 6 * 3600 * 1000);
  } catch (e) {
    S.article = {
      error: (e && e.message) || "网络异常",
      title: title || "",
      url,
    };
  }
  render();
}

/* ---- 板块详情 ---- */
function viewSectorDetail() {
  const d = S.sectorDetail;
  if (!d) return '<div class="empty">加载中…</div>';
  if (d.error) {
    return '<div class="empty">加载失败：' + d.error
      + '<br><br><span id="secBack" class="t-accent">返回</span></div>';
  }

  /* 完全没数据时给一句人话，不要留一片空白让人以为卡死 */
  const hasAny = (d.stocks && d.stocks.length) || (d.kline && d.kline.length)
    || d.score != null || d.pct != null || d.mainIn != null;
  if (!hasAny) {
    return '<div class="asset"><div class="label">板块</div>'
      + '<div class="row1"><div class="big" style="font-size:var(--fs-2xl)">'
      + (d.name || '') + '</div></div></div>'
      + '<div class="empty">这个板块暂时没有可用的行情数据'
      + '<br><span class="t-sm">行情源没有返回，稍后下拉可重试</span>'
      + '<br><br><span id="secBack" class="t-accent">返回</span></div>';
  }

  const yi = v => (v == null || !isFinite(v) ? '--' : (v / 1e8).toFixed(2));
  const row = (label, val, cls) =>
    '<div class="kv"><span class="k">' + label + '</span>'
    + '<span class="v ' + (cls || '') + '">' + val + '</span></div>';

  // 头部：名称 + 涨跌
  let html = '<div class="asset">'
    + '<div class="label">' + (d.stockCount ? d.stockCount + ' 只成分股' : '板块') + '</div>'
    + '<div class="row1">'
    + '<div class="big" style="font-size:var(--fs-2xl)">' + (d.name || '') + '</div>'
    + '<div class="today ' + pctCls(d.pct) + '">' + pctTxt(d.pct) + '</div>'
    + '</div>'
    + '<div class="sub">'
    + (d.value ? '<span>市值 ' + fmt(d.value / 1e8, 0) + ' 亿</span>' : '')
    + (d.up != null ? '<span>涨 ' + d.up + ' / 跌 ' + d.down + '</span>' : '')
    + '</div></div>';

  // 分时走势
  /* 估值：用跟踪指数的 PE 和历史分位。没对应指数就不显示，不硬凑 */
  const idxInfo = indexOf(d.name || '');
  const valRec = idxInfo ? valuationByCode(idxInfo.code) : null;
  const val = evaInfo(valRec);
  if (val) {
    const vcol = val.cls === 'up' ? 'var(--up)'
      : (val.cls === 'down' ? 'var(--down)' : 'var(--fg2)');
    html += '<div class="pcard-tight">'
      + '<div class="pcard-cap">估值 · 跟踪 ' + idxInfo.name + '</div>'
      + '<div style="display:flex;align-items:baseline;gap:var(--sp-3)">'
      + '<span style="font-size:var(--fs-2xl);font-weight:700">PE '
      + fmt(val.pe, 1) + '</span>'
      + '<span style="color:' + vcol + ';font-size:var(--fs-sm);font-weight:600">'
      + val.label + ' · 分位 ' + val.pctText + '</span></div>'
      + '<div class="mbar" style="margin-top:var(--sp-2)"><i style="width:'
      + Math.min(100, Math.max(2, (val.pct || 0) * 100))
      + '%;background:' + vcol + '"></i></div>'
      + '<div class="t-dim t-xs" style="margin-top:6px">历史分位越低越便宜 · '
      + (val.date || '') + '</div>'
      + '</div>';
  }

  if (d.trend && d.trend.length > 1) {
    html += '<div class="pcard-tight">'
      + '<div class="pcard-cap">分时走势</div>'
      + trendLine(d.trend) + '</div>';
  }

  // 概念板块：没有成分股，但有情绪分和商品价格，照样能看
  if (d.conceptOnly) {
    if (d.score != null) {
      const col = d.color || '#6b7280';
      html += '<div class="pcard">'
        + '<div style="color:var(--dim);font-size:var(--fs-sm);margin-bottom:8px">板块情绪</div>'
        + '<div style="display:flex;align-items:baseline;gap:8px">'
        + '<span style="font-size:var(--fs-3xl);font-weight:700;color:' + col + '">'
        + Math.round(d.score) + '</span>'
        + '<span style="color:var(--dim);font-size:var(--fs-sm)">/100 · '
        + (d.status || '') + '</span></div>'
        + '<div class="mbar" style="margin-top:8px"><i style="width:'
        + Math.min(d.score, 100) + '%;background:' + col + '"></i></div>'
        + (d.buySell ? '<div class="mfoot"><span>买卖 ' + d.buySell + '</span></div>' : '')
        + '</div>';
    }
    if (d.commod) {
      html += '<div class="pcard">'
        + '<div class="pcard-cap">关联品种</div>'
        + '<div class="kv"><span class="k">' + d.commod.name + '</span>'
        + '<span class="v ' + pctCls(d.commod.pct) + '">'
        + fmt(d.commod.price) + '　' + pctTxt(d.commod.pct) + '</span></div></div>';
    }
  }

  /* 蜡烛 K 线：比折线更能看出多空拉锯的过程 */
  if (d.kline && d.kline.length > 2) {
    html += '<div class="pcard-tight">'
      // 标题用板块名：用户在「机械设备」的详情页里，
      // 看到「K 线 · sz399233」根本不知道这是什么
      + candleChart(d.kline, 'K 线 · ' + (d.name || ''), d.klineCode || '')
      + '</div>';
  }

  // 相关异动：解释它今天为什么这样走
  const ev = newsBlock(d.name, 6);
  if (ev) {
    html += '<div class="pcard">'
      + '<div style="color:var(--dim);font-size:var(--fs-sm);margin-bottom:2px">'
      + '相关消息</div>' + ev + '</div>';
  }

  // 资金流拆解
  if (d.mainIn != null) {
    html += '<div class="pcard">'
      + '<div class="pcard-cap">资金流（亿元）</div>'
      + row('主力净流入', (d.mainIn >= 0 ? '+' : '') + yi(d.mainIn), pctCls(d.mainIn))
      + (d.superIn != null ? row('· 超大单', (d.superIn >= 0 ? '+' : '') + yi(d.superIn), pctCls(d.superIn)) : '')
      + (d.largeIn != null ? row('· 大单', (d.largeIn >= 0 ? '+' : '') + yi(d.largeIn), pctCls(d.largeIn)) : '')
      + (d.midIn != null ? row('· 中单', (d.midIn >= 0 ? '+' : '') + yi(d.midIn), pctCls(d.midIn)) : '')
      + (d.smallIn != null ? row('· 小单', (d.smallIn >= 0 ? '+' : '') + yi(d.smallIn), pctCls(d.smallIn)) : '')
      + '</div>';
  }

  // 涨跌家数
  if (d.up != null || d.down != null) {
    html += '<div class="pcard">'
      + '<div class="pcard-cap">涨跌分布</div>'
      + row('上涨家数', (d.up || 0) + ' 家', 'up')
      + row('下跌家数', (d.down || 0) + ' 家', 'down')
      + (d.leader ? row('领涨股', d.leader + ' ' + pctTxt(d.leaderPct), '') : '')
      + '</div>';
  }

  // 情绪（只有 data_valid 的才展示，避免假数据）
  const momHit = (S.mom || []).find(m =>
    m.valid && (m.name === d.name
      || (d.name && (d.name.includes(m.name) || m.name.includes(d.name)))));
  if (momHit) {
    html += '<div class="pcard">'
      + '<div class="pcard-cap">板块情绪</div>'
      + '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:8px">'
      + '<span style="font-size:var(--fs-2xl);font-weight:700;color:' + momHit.color + ';line-height:1">'
      + Math.round(momHit.score) + '</span>'
      + '<span style="color:var(--dim);font-size:var(--fs-sm)">/ 100</span>'
      + '<span style="margin-left:auto;color:' + momHit.color + ';font-size:var(--fs-sm);font-weight:600">'
      + momHit.status + '</span></div>'
      + row('热度', fmt(momHit.heat, 1))
      + row('买卖结构', momHit.buySell)
      + '</div>';
  }

  // 成分股
  if (d.stocks && d.stocks.length) {
    html += '<div class="pcard">'
      + '<div style="color:var(--dim);font-size:var(--fs-sm);margin-bottom:4px">成分股（按涨幅）</div>';
    for (const st of d.stocks) {
      const pc = st.pct != null ? st.pct : st.changePct;
      const amt = st.turnoverAmount != null ? st.turnoverAmount / 1e8
        : (st.mainIn != null ? st.mainIn / 1e8 : null);
      html += '<div class="kv"><span class="k">' + st.name
        + ' <span class="t-dim t-xs">'
        + (st.code || '').replace(/\.[A-Z]+$/, '') + '</span></span>'
        + '<span class="v ' + pctCls(pc) + '">' + pctTxt(pc)
        + (amt != null ? ' <span class="t-dim t-xs">'
          + fmt(amt, 1) + '亿</span>' : '')
        + '</span></div>';
    }
    html += '</div>';
  }

  html += '<div style="margin-top:10px">'
    + '<div class="fund" id="secBack"><div class="c0"><div class="nm">返回</div></div>'
    + '<div class="c1 t-dim">›</div></div></div>';

  return html;
}

/** 分时折线（SVG）。 */
function trendLine(points) {
  const w = 320, h = 90, pad = 4;
  const ys = points.map(p => p.p);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = (max - min) || 1;
  const pts = points.map((p, i) => {
    const x = pad + (w - pad * 2) * i / (points.length - 1);
    const y = h - pad - (h - pad * 2) * (p.p - min) / span;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const color = up ? 'var(--up)' : 'var(--down)';
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:90px">'
    + '<polyline points="' + pts + '" fill="none" stroke="' + color
    + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>'
    + '<div style="display:flex;justify-content:space-between;color:var(--dim);font-size:var(--fs-xs)">'
    + '<span>' + points[0].t + '</span><span>' + points[points.length - 1].t + '</span></div>';
}

/**
 * 打开板块详情。
 * 主数据来自全市场热力图（板块 + 全部成分股，一次请求就够），
 * 再用东财资金流接口补主力/散户拆解；后者失败也不影响主体展示。
 */
/**
 * 拉当前板块的分钟 K 线。
 *
 * 原来这段逻辑只挂在「点周期按钮」的事件里，可周期按钮本身画在
 * K 线卡片内部，而卡片要 d.kline 有数据才渲染——
 * 于是永远没有按钮可点，K 线一次都不会出现。
 * 现在改成打开板块详情就主动拉一次，按钮只负责换周期。
 */
async function loadSectorKline() {
  const d = S.sectorDetail;
  if (!d) return;
  const kc = d.klineCode || sectorQuoteCode(d.name);
  if (!kc) return;

  const who = d.name;
  try {
    const bars = await api.kline(kc, S.klineScale || 5, 60);
    /*
     * 拉的过程中用户可能已经返回或翻到别的板块了，
     * 这时不能再写回——否则会把上一个板块的 K 线画到新板块头上。
     */
    if (bars && bars.length > 2 && S.sectorDetail && S.sectorDetail.name === who) {
      S.sectorDetail = Object.assign({}, S.sectorDetail, { kline: bars, klineCode: kc });
      render();
    }
  } catch (e) { /* K 线是增强内容，拉不到不影响页面主体 */ }
}

async function openSectorDetail(codeOrName, name, isBack) {
  S._playEnter = true;
  if (!isBack) {
    S.sectorFrom = S.tab;
    nav.push();
  }
  S.tab = 'sectorDetail';
  S.sectorDetail = null;
  render();

  const key = codeOrName;
  const boards = (S.heat && S.heat.boards) || [];
  const board = boards.find(b => b.code === key || b.name === key
    || b.name === name || (name && b.name.includes(name)));

  if (board) {
    S.sectorDetail = {
      name: board.name,
      code: board.code,
      pct: board.pct,
      value: board.value,
      stockCount: board.stockCount,
      up: board.up,
      down: board.down,
      stocks: (board.stocks || []).slice().sort(
        (a, b) => (b.changePct || 0) - (a.changePct || 0)),
    };
    render();
  }

  /*
   * 没在行业热力布里找到。
   *
   * 这是常态而不是异常：情绪榜里很多是概念板块（黄金、CPO、CRO），
   * findfin 只按申万一级行业分，压根没有这些分类。
   * 以前这里会一直停在「加载中」，点进去像卡死。
   * 现在用情绪榜自己的数据兜底，至少分数、涨跌、相关消息都在。
   */
  if (!S.sectorDetail) {
    const mood = (S.mood || []).find(m => m.name === key || m.name === name);
    // 商品类板块顺带带上期货价格，比一个空涨跌幅有用
    let comm = null;
    if (S.commod) {
      comm = S.commod.find(c =>
        (name || key).indexOf(c.name.replace(/^COMEX|^NYMEX/, '')) >= 0
        || c.name.indexOf(name || key) >= 0);
    }
    S.sectorDetail = {
      commod: comm ? comm : null,
      name: (mood && mood.name) || name || String(key),
      code: key,
      pct: mood ? mood.pct : null,
      score: mood ? mood.score : null,
      heat: mood ? mood.heat : null,
      status: mood ? mood.status : null,
      color: mood ? mood.color : null,
      buySell: mood ? mood.buySell : null,
      stocks: [],
      conceptOnly: true,
    };
    render();
  }

  /*
   * 成分股补齐。
   *
   * 行业板块在 findfin 里有完整成分股；但概念板块（黄金、CPO、CRO 之类）
   * findfin 按申万一级行业分，压根没有这些分类，点进去就是空的。
   * 这里用东财的板块成分股接口补上，点到哪个板块都能看到具体个股。
   */
  if (S.sectorDetail && !(S.sectorDetail.stocks || []).length) {
    try {
      /* 先在热力图里按名字模糊找（行业板块全覆盖），再走东财补概念板块 */
      const nm = S.sectorDetail.name || name || key;
      const boards = (S.heat && S.heat.boards) || [];
      const bd = boards.find(b => b.name === nm)
        || boards.find(b => b.name.indexOf(nm) >= 0 || nm.indexOf(b.name) >= 0);

      let list = (bd && bd.stocks && bd.stocks.length) ? bd.stocks : null;
      if (!list) list = await api.sectorStocks(nm);
      if (list && list.length && S.sectorDetail) {
        S.sectorDetail = Object.assign({}, S.sectorDetail, {
          stocks: list,
          stockCount: list.length,
        });
        render();
      }
    } catch (e) { /* 补不到就算了，页面其余部分照常 */ }
  }

  // 补资金流（按板块名去东财列表里找）
  try {
    const list = await api.sectors('industry');
    const hit = list.find(x => x.name === (board ? board.name : name));
    if (hit && S.sectorDetail) {
      S.sectorDetail = { ...S.sectorDetail, ...hit, name: S.sectorDetail.name };
      render();
    }
  } catch (e) { /* 资金流失败不影响主体 */ }

  // K 线放最后：它要用板块名去查行业指数，得等名字定下来
  await loadSectorKline();
}

/* ---- 我的 ---- */
/** 设置项行 */
function setRow(id, name, desc, right) {
  return '<div class="fund" id="' + id + '">'
    + '<div class="c0"><div class="nm">' + name + '</div>'
    + (desc ? '<div class="amt">' + desc + '</div>' : '')
    + '</div>'
    + '<div class="c1 t-dim" style="width:auto">' + (right || "›") + '</div>'
    + '</div>';
}

/** 设置分组标题 */
function setGroup(title, body) {
  return '<div class="setgroup">' + title + '</div>'
    + '<div class="listwrap">' + body + '</div>';
}

function viewMe() {
  const n = S.holdings.length, w = S.watch.length;

  let html = '<div class="assetcard" style="margin-bottom:var(--sp-4)">';
  html += '<div class="ac-top"><span>本地数据</span></div>';
  html += '<div class="ac-num" style="font-size:var(--fs-2xl)">'
    + n + ' 只持仓 · ' + w + ' 只自选</div>';
  html += '<div class="ac-tags"><span class="tag">全部存于本机</span>'
    + '<span class="tag">无账号 · 无上传</span></div>';
  html += '</div>';

  html += setGroup("常用",
    setRow("miTheme", "外观主题", "", theme.label(theme.mode))
    + setRow("miSettings", "设置", "日志 · 自检 · 数据管理")
  );

  html += '<div class="newsend" style="line-height:1.9">'
    + '数据源：天天基金 · 腾讯财经 · 同花顺 · 蛋卷<br>'
    + '无广告 · 无账号 · 无后台<br>'
    + '<span style="color:var(--accent)">AI 校准由 DeepSeek 驱动</span>'
    + ' · powered by dsh</div>';

  return html;
}

/** 设置二级页 */
function viewSettings() {
  let html = '';

  /* 桥接状态：logcat 不通时这里能直接看出哪个方法缺了 */
  html += setGroup("诊断信息",
    setRow("", "原生桥", nativeProbe(), "")
  );

  /* 外观 */
  html += setGroup("外观",
    setRow("miTheme", "主题", "自动 / 浅色 / 深色", theme.label(theme.mode))
  );

  /* 调试 */
  html += setGroup("调试",
    setRow("miLogOn", "记录运行日志",
      "开启后记录接口结果与错误，便于排查",
      '<span style="color:' + (S.logOn ? "var(--accent)" : "var(--dim)") + '">'
      + (S.logOn ? "已开启" : "已关闭") + '</span>')
    + setRow("miLog", "调试日志", (S.logOn ? diag.buf.length + " 条记录" : "日志开关已关闭"))
    + setRow("miPing", "测试日志通道", "写一条到 logcat 和文件")
    // 数量跟 runDiagnostics() 里的 await t( 条数保持一致，否则文案对不上
    + setRow("miDiag", "数据源自检", "逐个测试 18 个接口")
  );

  /* 数据 */
  /* AI 校准 */
  const aiSum = ai.summary();
  const aiDesc = !aiSum.configured ? "填入 API Key 后才会生效"
    : (!aiSum.on ? "已关闭"
      : (aiSum.cooling ? "连续失败，冷却中（还有 " + aiSum.coolLeft + " 分钟）"
        : (aiSum.count ? "已校准 " + aiSum.count + " 只 · 上次 "
            + (aiSum.rows[aiSum.rows.length - 1] || {}).day
          : "净值更新后自动对比今日与历史差异")));
  html += setGroup("AI 校准 · DeepSeek 驱动",
    setRow("miAiCfg", "AI 接口配置",
      aiSum.configured ? (aiSum.model + " · 已填入 Key") : "未配置 · 支持任意 OpenAI 兼容接口",
      '<span style="color:' + (aiSum.configured ? "var(--accent)" : "var(--up)") + '">'
      + (aiSum.configured ? "已配置" : "去填写") + ' ›</span>')
    + setRow("miAiOn", "AI 误差校准",
      "净值更新后对比今日与历史差异，自动调整模型权重",
      '<span style="color:' + (aiSum.on ? "var(--accent)" : "var(--dim)") + '">'
      + (aiSum.on ? "已开启" : "已关闭") + '</span>')
    + setRow("miAiInfo", "校准状态", aiDesc)
    + setRow("miAiRun", "立即校准", "不等下次刷新，现在就跑一遍")
  );

  html += setGroup("数据",
    setRow("miExport", "导出数据", "生成 JSON 文本，可自行备份")
    + setRow("miClear", "清空所有数据", "持仓、自选与全部缓存",
      '<span style="color:var(--up)">清空</span>')
  );

  html += '<div class="newsend" style="line-height:1.9">'
    + '养基宝 Lite · v1<br>'
    + '数据仅供参考，不构成投资建议</div>';

  return html;
}

/* ---- 基金详情 ---- */
function viewDetail() {
  const d = S.detail;
  if (!d) return `<div class="empty">加载中…</div>`;
  if (d.error) return `<div class="empty">加载失败：${d.error}</div>`;

  const stageRow = (label, v) =>
    `<div style="flex:1;text-align:center">
       <div class="t-dim t-xs">${label}</div>
       <div class="${pctCls(v || 0)}" style="font-weight:600;margin-top:3px">${pctTxt(v)}</div>
     </div>`;

  let html = `<div class="asset">
    <div class="label">${d.code}</div>
    <div class="row1"><div class="big" style="font-size:var(--fs-2xl)">${d.name || d.code}</div></div>
    <div class="sub">
      ${d.rate ? `<span>费率 ${d.rate}%</span>` : ''}
      ${d.minBuy ? `<span>起购 ${d.minBuy} 元</span>` : ''}
    </div>
  </div>`;

  html += `<div class="fund" style="justify-content:space-between;padding:14px 16px">
    ${stageRow('近1月', d.syl_1y)}${stageRow('近3月', d.syl_3y)}
    ${stageRow('近6月', d.syl_6y)}${stageRow('近1年', d.syl_1n)}
  </div>`;

  /* 历史净值走势：带区间切换，数据来自全量历史 */
  html += '<div class="pcard-tight">' + navChart(d.code) + '</div>';

  if (d.manager) {
    const stars = '★'.repeat(d.manager.star || 0);
    html += `<div class="pcard-tight">
      <div class="pcard-cap">基金经理</div>
      <div><b>${d.manager.name || '--'}</b>
        <span style="color:#f0b400;font-size:var(--fs-sm);margin-left:6px">${stars}</span></div>
      <div style="color:var(--dim);font-size:var(--fs-sm);margin-top:4px">
        从业 ${d.manager.workTime || '--'} · 规模 ${d.manager.fundSize || '--'}</div>
    </div>`;
  }

  if (d.alloc && d.alloc.length) {
    html += `<div class="pcard-tight">
      <div style="color:var(--dim);font-size:var(--fs-sm);margin-bottom:4px">资产配置</div>
      ${/*
         * 「净资产」这一条的量纲是**亿元**，不是占净比。
         * pingzhongdata 的 Data_assetAllocation 把 股票/债券/现金（占净比 %）
         * 和 基金净资产（亿元）放在同一个 series 里，
         * 无脑拼一个 % 就会出现「净资产 313.02%」这种笑话。
         */''}
      ${d.alloc.map(a => a.name === '净资产'
        ? `<div class="kv"><span class="k">${a.name}</span>
        <span class="v t-dim">${fmt(a.value)} 亿元</span></div>`
        : `<div class="kv"><span class="k">${a.name}</span>
        <span class="v">${fmt(a.value)}%</span></div>`).join('')}
    </div>`;
  }

  if (d.predict) {
    const pr = d.predict;
    html += `<div class="pcard-tight">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px">
        <span style="color:var(--dim);font-size:var(--fs-sm)">盘中预估</span>
        <span class="${pctCls(pr.est)}" style="font-size:22px;font-weight:700;
          font-variant-numeric:tabular-nums">${pctTxt(pr.est)}</span>
        <span style="margin-left:auto;color:var(--dim);font-size:var(--fs-xs)">
          ${pr.at}${pr.method === 'index' || pr.method === 'fused'
            ? (pr.indexName ? ' · 跟 ' + pr.indexName : '')
            : ' · 覆盖 ' + fmt((pr.covered || 0) * 100, 0) + '%'}</span>
      </div>
      <div style="color:var(--dim);font-size:var(--fs-sm);line-height:1.6;
        margin-bottom:10px">
        前十大重仓实时涨跌 × 占净值权重归一化加权；报告期 ${pr.report || '--'}。
        盘中估算，晚间以基金公司正式净值为准。</div>
      ${pr.parts.map(x => {
        const w = Math.min(Math.abs(x.contrib) / 0.6, 1) * 50;
        const col = x.contrib >= 0 ? 'var(--up)' : 'var(--down)';
        return `<div class="contrib" style="color:${col}">
          <span class="nm" style="color:var(--fg)">${x.name}</span>
          <span class="w">${fmt(x.weightPct)}%</span>
          <span class="v" style="color:${col}">${pctTxt(x.pct)}</span>
          <span class="bar"><i style="${x.contrib >= 0
            ? `left:50%;width:${w}%`
            : `left:${50 - w}%;width:${w}%`}"></i></span>
          <span class="v" style="width:62px;color:${col}">
            ${x.contrib > 0 ? '+' : ''}${fmt(x.contrib, 3)}</span>
        </div>`;
      }).join('')}
      ${pr.missing.length ? `<div style="color:var(--dim);font-size:var(--fs-xs);
        margin-top:8px">无行情：${pr.missing.join('、')}</div>` : ''}
      ${pr.fit ? `<div style="margin-top:10px;padding-top:9px;
        border-top:1px dashed var(--line);font-size:var(--fs-sm);color:var(--dim);
        line-height:1.8">
        <span class="pill pred">β 校准</span>
        β ${fmt(pr.beta, 2)} · 近 ${pr.fit.n} 次平均误差
        ${fmt(pr.fit.mae, 2)}pct · 方向命中
        ${fmt(pr.fit.hitRate * 100, 0)}%
        ${pr.fit.r2 != null
          ? '<br>拟合优度 R² ' + fmt(pr.fit.r2, 2)
            + '（越高说明重仓股越能解释净值）' : ''}
      </div>` : `<div style="margin-top:10px;padding-top:9px;
        border-top:1px dashed var(--line);font-size:var(--fs-sm);color:var(--dim)">
        还没有历史样本。每天收盘后会用真实净值做回归，
        自动算出这只基金对重仓股的敏感度 β，越用越准。</div>`}
    </div>`;
  }

  if (d.holdings && d.holdings.length) {
    html += `<div class="pcard-tight">
      <div style="color:var(--dim);font-size:var(--fs-sm);margin-bottom:4px">前十大重仓</div>
      ${d.holdings.map(h => {
        const q = d.quotes ? d.quotes[h.code] : null;
        return `<div class="kv">
          <span class="k">${h.name} <span class="t-dim t-xs">${h.code}</span></span>
          <span class="v">${fmt(h.weightPct)}%
            ${q != null ? `<span class="${pctCls(q)}" style="margin-left:8px">${pctTxt(q)}</span>` : ''}
          </span></div>`;
      }).join('')}
    </div>`;
  }

  html += `<div style="margin-top:10px">
    <div class="fund" id="detWatch"><div class="c0"><div class="nm">加入自选</div></div>
      <div class="c1 t-dim">›</div></div>
    <div class="fund" id="detBack"><div class="c0"><div class="nm">返回</div></div>
      <div class="c1 t-dim">›</div></div>
  </div>`;

  return html;
}

function sparkline(trend) {
  const w = 320, h = 96, pad = 6;
  const ys = trend.map(p => p.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = (max - min) || 1;
  const pts = trend.map((p, i) => {
    const x = pad + (w - pad * 2) * i / (trend.length - 1);
    const y = h - pad - (h - pad * 2) * (p.y - min) / span;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const color = up ? 'var(--up)' : 'var(--down)';
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:96px">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.7"
      stroke-linejoin="round" stroke-linecap="round"/>
  </svg>
  <div style="display:flex;justify-content:space-between;
    color:var(--dim);font-size:var(--fs-xs)">
    <span>${fmt(min, 4)}</span><span>${fmt(max, 4)}</span>
  </div>`;
}



/* ---------------- 蜡烛 K 线 ----------------
 *
 * 放在板块详情页。数据来自新浪的分钟/日线接口，带完整 OHLC。
 *
 * 国内习惯：涨用红、跌用绿，和欧美相反。
 * 阳线画空心（描边），阴线画实心，这是 A 股软件的通行画法。
 * ---------------- */

const KLINE_SCALES = [
  { id: 5,   name: "5分" },
  { id: 15,  name: "15分" },
  { id: 30,  name: "30分" },
  { id: 60,  name: "60分" },
  { id: 240, name: "日线" },
];

/** 板块/指数名 -> 行情代码 */
function sectorQuoteCode(name) {
  const nm = name || "";
  /*
   * 行业名 -> 行业指数代码。
   *
   * 这批代码是实测出来的：枚举了上证 sh000001-000999 与深证
   * sz399001-399998 的全部指数，逐个拉 5 分钟 K 线，
   * 只保留「最新数据日期就是今天」的那些。
   *
   * 这一步很关键。第一次筛出来的 30 个里，有 9 个其实是停更指数
   * ——能返回数据，但日期停在 6 月、3 月甚至去年 12 月。
   * 不看日期直接用，K 线上就会显示几个月前的行情。
   *
   * 现在 32 个行业全部对应到当天有行情的指数，无一停更。
   * 其中 6 个行业没有独立的行业指数，用邻接行业替代，已在下面注明。
   */
  const MAP = {
    // ---- 有独立行业指数 ----
    "电子":     "sh000935",   // 中证信息
    "计算机":   "sh000935",
    "传媒":     "sz399434",   // 数字传媒
    "银行":     "sz399431",   // 国证银行
    "非银金融": "sh000934",   // 中证金融
    "房地产":   "sz399393",   // 国证地产
    "医药生物": "sh000037",   // 上证医药
    "煤炭":     "sz399998",   // 中证煤炭
    "有色金属": "sh000819",   // 有色金属
    "国防军工": "sz399967",   // 中证军工
    "建筑装饰": "sz399235",   // 建筑指数
    "建筑材料": "sz399235",
    "交通运输": "sz399237",   // 运输指数
    "钢铁":     "sz399440",   // 国证钢铁
    "环保":     "sh000827",   // 中证环保
    "石油石化": "sh000928",   // 中证能源
    "电力设备": "sz399417",   // 新能源车
    "汽车":     "sz399432",   // 智能汽车
    "综合":     "sh000008",   // 综合指数
    "家用电器": "sz399996",   // 智能家居

    // ---- 无独立指数，用邻接行业替代 ----
    "通信":     "sh000993",   // 全指信息
    "食品饮料": "sh000932",   // 中证消费
    "机械设备": "sz399233",   // 制造指数
    "基础化工": "sh000033",   // 上证材料
    "公用事业": "sh000041",   // 上证公用
    "农林牧渔": "sz399231",   // 农林指数
    "轻工制造": "sz399233",   // 制造指数
    "商贸零售": "sh000005",   // 商业指数
    "纺织服饰": "sz399320",   // 国证服务
    "社会服务": "sz399320",
    "美容护理": "sh000932",   // 中证消费
    "其他":     "sh000001",   // 上证指数
  };
  /*
   * 先查上面这张行业表。
   *
   * 它和下面 indexOf() 用的 INDEX_MAP 口径不同：
   * INDEX_MAP 是「基金名 -> 它跟踪哪个指数」，为的是算跟踪误差和 β；
   * 拿它当板块映射会串味——「食品饮料」里有「白酒」两个字，
   * 于是会命中 /白酒|食品饮料/ 落到中证白酒；
   * 「银行」会落到中证银行而不是国证银行。
   * 上面这张表是按「板块」口径逐个实测过的，所以它优先。
   */
  for (const k in MAP) {
    if (nm.indexOf(k) >= 0) return MAP[k];
  }

  // 表里没有的（概念板块、宽基、港美股），退回基金口径的指数映射
  const idx = indexOf(nm);
  if (idx) return idx.code;
  return null;
}

/**
 * 画蜡烛图。
 *
 * 宽度按根数自适应：根数少就宽一点，多了就窄，
 * 但保证最小 1.5px，否则手机上就是一团糊。
 */
function candleChart(bars, title, track) {
  if (!bars || bars.length < 3) {
    return '<div class="chartempty">暂无 K 线数据</div>';
  }

  const W = 320, H = 132, PADT = 10, PADB = 8, PADX = 2;
  const n = bars.length;

  let hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  const room = (hi - lo) || (hi * 0.01) || 1;
  hi += room * 0.04;
  lo -= room * 0.04;

  const slot = (W - PADX * 2) / n;
  const bw = Math.max(1.5, Math.min(slot * 0.68, 9));
  const y = v => H - PADB - (H - PADT - PADB) * ((v - lo) / (hi - lo));
  const cx = i => PADX + slot * (i + 0.5);

  let svg = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" '
    + 'style="width:100%;height:' + H + 'px;display:block">';

  for (const f of [0, 0.5, 1]) {
    const gy = PADT + (H - PADT - PADB) * f;
    svg += '<line x1="0" y1="' + gy.toFixed(1) + '" x2="' + W
      + '" y2="' + gy.toFixed(1) + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 4"/>';
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const up = b.close >= b.open;
    const col = up ? "var(--up)" : "var(--down)";
    const x = cx(i);

    // 上下影线
    svg += '<line x1="' + x.toFixed(1) + '" y1="' + y(b.high).toFixed(1)
      + '" x2="' + x.toFixed(1) + '" y2="' + y(b.low).toFixed(1)
      + '" stroke="' + col + '" stroke-width="1"/>';

    // 实体：阳线空心、阴线实心
    const top = y(Math.max(b.open, b.close));
    const bot = y(Math.min(b.open, b.close));
    const h = Math.max(1, bot - top);
    svg += '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + top.toFixed(1)
      + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" '
      + (up ? 'fill="none" stroke="' + col + '" stroke-width="1"'
            : 'fill="' + col + '"') + "/>";
  }
  svg += "</svg>";

  const first = bars[0].open;
  const last = bars[bars.length - 1].close;
  const pct = first ? (last / first - 1) * 100 : 0;

  let html = '<div class="charttop"><span class="chartlab">' + (title || "K 线")
    + '</span><span class="chartpct ' + pctCls(pct) + '">' + pctTxt(pct) + "</span></div>";

  html += '<div class="charttabs">';
  for (const sc of KLINE_SCALES) {
    const on = (S.klineScale || 5) === sc.id;
    html += '<button data-kline="' + sc.id + '" class="' + (on ? "on" : "")
      + '">' + sc.name + "</button>";
  }
  html += "</div>";

  html += '<div class="chartbox">' + svg;
  html += '<div class="chartaxis"><span>' + (bars[0].time || "").slice(5, 16)
    + '</span><span>高 ' + fmt(hi, 2) + " · 低 " + fmt(lo, 2) + '</span><span>'
    + (bars[bars.length - 1].time || "").slice(5, 16) + "</span></div></div>";

  html += '<div class="chartfoot">' + n + " 根 · "
    + KLINE_SCALES.filter(x => x.id === (S.klineScale || 5))[0].name
    // 把跟踪的指数代码放在页脚小字里。标题留给用户看得懂的板块名，
    // 代码对排查有用但不是给人读的。
    + (track ? ' · 跟踪 ' + track : '') + "</div>";
  return html;
}
/* ---------------- 历史走势图 ----------------
 *
 * 放在基金详情页。基金只有单位净值一个序列，没有 OHLC，
 * 所以画的是折线而不是蜡烛 K 线——硬画成 K 线是假的。
 *
 * 支持的区间：1月 / 3月 / 6月 / 1年 / 全部，
 * 底部标注区间涨跌、最高、最低、起止日期。
 * ---------------- */

/** 区间定义（按交易日数量近似） */
const CHART_RANGES = [
  { id: 20,  name: "1月" },
  { id: 60,  name: "3月" },
  { id: 120, name: "6月" },
  { id: 250, name: "1年" },
  { id: 0,   name: "全部" },
];

/** 取某个区间的净值序列 */
function chartSeries(code) {
  const full = S.full[code];
  if (!full || !full.trend || full.trend.length < 2) return null;

  const range = S.chartRange === undefined ? 60 : S.chartRange;
  const all = full.trend;
  const data = range > 0 ? all.slice(-range) : all;
  if (data.length < 2) return null;

  const navs = data.map(x => x.nav);
  const lo = Math.min.apply(null, navs);
  const hi = Math.max.apply(null, navs);
  const first = navs[0];
  const last = navs[navs.length - 1];

  return {
    data, lo, hi, first, last,
    pct: first ? (last / first - 1) * 100 : 0,
    from: data[0].date, to: data[data.length - 1].date,
  };
}

/**
 * 画净值走势图。
 *
 * 用 viewBox 等比缩放，屏幕多宽都清晰；
 * 只画 path 和 text，缩放时不触发重排。
 */
function navChart(code) {
  const s = chartSeries(code);
  if (!s) return '<div class="chartempty">历史数据不足</div>';

  const W = 320, H = 130, PADX = 4, PADT = 12, PADB = 6;
  const n = s.data.length;
  const up = s.pct >= 0;
  const color = up ? "var(--up)" : "var(--down)";

  // 上下留 6% 余量，曲线不贴边
  const room = (s.hi - s.lo) || (s.hi * 0.01) || 1;
  const lo = s.lo - room * 0.06;
  const hi = s.hi + room * 0.06;

  const x = i => PADX + (W - PADX * 2) * (n === 1 ? 0 : i / (n - 1));
  const y = v => H - PADB - (H - PADT - PADB) * ((v - lo) / (hi - lo));

  let d = "";
  for (let i = 0; i < n; i++) {
    d += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(s.data[i].nav).toFixed(1) + " ";
  }

  // 面积渐变：让曲线下面有一点体积感，但很淡
  const area = d + "L" + x(n - 1).toFixed(1) + " " + H + " L" + x(0).toFixed(1) + " " + H + " Z";
  const gid = "g" + code;

  let svg = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" '
    + 'style="width:100%;height:' + H + 'px;display:block">';
  svg += '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="' + color + '" stop-opacity=".18"/>'
    + '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';

  // 三条参考网格
  for (const f of [0, 0.5, 1]) {
    const gy = PADT + (H - PADT - PADB) * f;
    svg += '<line x1="' + PADX + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PADX)
      + '" y2="' + gy.toFixed(1) + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 4"/>';
  }

  svg += '<path d="' + area + '" fill="url(#' + gid + ')"/>';
  svg += '<path d="' + d + '" fill="none" stroke="' + color
    + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';

  // 最高/最低点标记
  const hiIdx = s.data.findIndex(v => v.nav === s.hi);
  const loIdx = s.data.findIndex(v => v.nav === s.lo);
  for (const [idx, val] of [[hiIdx, s.hi], [loIdx, s.lo]]) {
    if (idx < 0) continue;
    svg += '<circle cx="' + x(idx).toFixed(1) + '" cy="' + y(val).toFixed(1)
      + '" r="2.2" fill="' + color + '"/>';
  }
  svg += "</svg>";

  /* 区间切换 */
  let html = '<div class="charttop">';
  html += '<span class="chartlab">净值走势</span>';
  html += '<span class="chartpct ' + pctCls(s.pct) + '">' + pctTxt(s.pct) + "</span>";
  html += "</div>";

  html += '<div class="charttabs">';
  for (const r of CHART_RANGES) {
    const on = (S.chartRange === undefined ? 60 : S.chartRange) === r.id;
    html += '<button data-chart="' + r.id + '" class="' + (on ? "on" : "")
      + '">' + r.name + "</button>";
  }
  html += "</div>";

  html += '<div class="chartbox">' + svg
    + '<div class="chartaxis"><span>' + (s.from || "") + "</span>"
    + '<span>高 ' + fmt(s.hi, 4) + " · 低 " + fmt(s.lo, 4) + "</span>"
    + '<span>' + (s.to || "") + "</span></div></div>";

  html += '<div class="chartfoot">' + s.data.length + " 个交易日 · 单位净值</div>";
  return html;
}
async function openDetail(code, isBack) {
  S._playEnter = true;
  if (!isBack) {
    S.detailFrom = S.tab;
    nav.push();
  }
  S.tab = 'detail';
  S.detail = null;
  syncBackState();
  render();
  try {
    const d = await api.fundDetail(code);
    try {
      const h = await api.stockHoldingsEx(code);
      d.holdings = h.list.sort((a, b) => b.weightPct - a.weightPct);
      d.report = h.report;
      if (d.holdings.length) {
        d.quotes = await api.stockQuotes(d.holdings.map(x => x.code));
      }
    } catch (e) { d.holdings = []; }

    /* 全量历史净值：走势图的数据源，缓存里已有就不重复请求 */
    try {
      if (!S.full[code]) S.full[code] = await api.fundFull(code);
    } catch (e) { /* 拿不到就画不出图，页面其余部分照常 */ }

    // 盘中预估（可缓存复用）
    try {
      d.predict = S.predict[code] || await predict.one(code);
      if (d.predict) S.predict[code] = d.predict;
    } catch (e) { d.predict = null; }

    S.detail = d;
  } catch (e) {
    S.detail = { error: e.message || String(e) };
  }
  render();
}

/* ---------------- 交互 ---------------- */
function switchTab(tab) {
  S._playEnter = true;
  if (S.tab !== tab) diag.info('切换页面 ' + S.tab + ' -> ' + tab);

  /*
   * mood / news / watch 都已经合并了，这里做兼容映射。
   *
   * 关键：映射前先把「用户点的是哪个入口」存下来。
   * 原来下面那个 if 判断用的还是映射**之后**的 tab，
   * 而此时 tab 已经变成 'discover'，
   * 于是 "if (tab === 'mood')" 和 "if (tab === 'news')" 永远不成立——
   * 情绪榜、热榜、资讯的首次加载全都不触发，
   * 用户点进「发现」看到的就是一片空白和骨架屏。
   */
  if (tab === 'mood') { S.discoverSeg = 'mood'; tab = 'discover'; }
  else if (tab === 'news') { S.discoverSeg = 'news'; tab = 'discover'; }
  else if (tab === 'watch') { S.assetSeg = 'watch'; tab = 'hold'; }
  nav.reset();          // 从底部导航切换 = 回到主界面，清空返回栈
  S.tab = tab;
  syncBackState();
  render();
  if (tab === 'market') {
    if (!S.heat) refreshHeat();
    if (!S.valuation) refreshValuation();
    if (!S.indices.length) refreshIndices().then(render);
  }
  if (tab === 'discover') {
    // 两块内容都备好：用户切分段时不用再等一轮网络
    if (!S.mood) refreshMood();
    if (!S.news) refreshNews();
    if (!S.hot) refreshHot();
    // 情绪卡片要能跳到板块详情，先把板块列表备好
    if (!S.sectors) refreshSectors('industry');
  }
}

function bindGlobal() {
  // 底部导航
  document.querySelectorAll('nav button').forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  // 芯片（分组）
  document.getElementById('chips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if (c.id === 'chipAdd') { askNewGroup(); return; }
    S.group = c.dataset.group;
    render();
  });

  // 长按持仓行 -> 操作菜单（编辑 / 删除 / 移动分组 / 置顶）
  let pressTimer = null;
  let longPressed = false;
  mainEl.addEventListener('touchstart', e => {
    const row = e.target.closest('[data-code]');
    if (!row) return;
    longPressed = false;
    const code = row.dataset.code;
    pressTimer = setTimeout(() => {
      longPressed = true;
      pressTimer = null;
      const h = S.holdings.find(x => x.code === code);
      if (h) openHoldMenu(h);
      else {
        const w = S.watch.find(x => x.code === code);
        if (w) openWatchMenu(w);
      }
    }, 480);
  }, { passive: true });
  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  mainEl.addEventListener('touchend', cancelPress, { passive: true });
  mainEl.addEventListener('touchmove', cancelPress, { passive: true });
  mainEl.addEventListener('touchcancel', cancelPress, { passive: true });

  // 主区委托：行点击 / 眼睛 / 批量 / 板块切换
  mainEl.addEventListener('click', e => {
    // 刚触发过长按，这一次 click 要吞掉，避免又跳进详情
    if (longPressed) { longPressed = false; return; }

    // 板块排序
    const srt = e.target.closest('[data-sort]');
    if (srt) { S.sectorSort = srt.dataset.sort; render(); return; }

    // 情绪排序
    const msrt = e.target.closest('[data-mood-sort]');
    if (msrt) { S.moodSort = msrt.dataset.moodSort; render(); return; }

    // 热榜排序
    const hsrt = e.target.closest('[data-hot-sort]');
    if (hsrt) { S.hotSort = hsrt.dataset.hotSort; render(); return; }

    // 情绪页分段
    const mt = e.target.closest('[data-mood-tab]');
    if (mt) {
      S.moodTab = mt.dataset.moodTab;
      render();
      if (S.moodTab !== 'mom' && !S.hot) refreshHot();
      if (S.moodTab === 'mom' && !S.mom) refreshMood();
      return;
    }

    // 热榜行 -> 对应板块详情
    const hr = e.target.closest('[data-hot-name]');
    if (hr) {
      const nm = decodeURIComponent(hr.dataset.hotName);
      const hit = (S.heat && S.heat.boards || []).find(b => b.name === nm)
        || (S.heat && S.heat.boards || []).find(
          b => b.name.indexOf(nm) >= 0 || nm.indexOf(b.name) >= 0);
      // 不管有没有行情明细，都进详情页；里面会补信息
      if (hit) openSectorDetail(hit.name);
      else openSectorDetail(nm);
      return;
    }

    if (e.target.closest('#moodRetry')) {
      S.mom = null; render(); refreshMood(); return;
    }

    if (e.target.closest('#secRetry')) {
      S.sectors = null; render(); refreshSectors(S.sectorKind); return;
    }

    // 行情分段
    const sg = e.target.closest('[data-seg]');
    if (sg) {
      S.mktSeg = sg.dataset.seg;
      if (S.mktSeg === 'global') { render(); refreshIndices().then(render); }
      else { S.sectorKind = S.mktSeg; S.sectors = null; render(); refreshSectors(S.sectorKind); }
      return;
    }

    if (e.target.closest('#newsRetry')) {
      S.news = null;
      refreshNews();
      return;
    }

    // 资讯条目 -> App 内正文
    // 情绪榜卡片：点进去看这个板块的详细情况
    const moodCard = e.target.closest('[data-mom-name]');
    if (moodCard && !e.target.closest('[data-article]')) {
      openSectorDetail(decodeURIComponent(moodCard.dataset.momName));
      return;
    }

    const art = e.target.closest('[data-article]');
    if (art) {
      const url = decodeURIComponent(art.dataset.article || '');
      const title = decodeURIComponent(art.dataset.title || '');
      openArticle(url, title);
      return;
    }

    // 正文页操作
    if (e.target.closest('#artBack')) {
      S.article = null;
      nav.back(S.articleFrom || 'news');
      return;
    }
    if (e.target.closest('#artRetry')) {
      const a = S.article;
      if (a && a.url) openArticle(a.url, a.title);
      return;
    }
    // 正文提取失败时的兜底出口：交给系统浏览器打开原网页。
    // 这个入口一直在界面上写着，但从来没有绑过处理器，点了没反应。
    if (e.target.closest('#artOpenWeb')) {
      const a = S.article;
      if (a && a.url && window.Native && Native.openUrl) Native.openUrl(a.url);
      else toast('当前环境无法调用系统浏览器');
      return;
    }
    // 缓存过期提示条上的「刷新」：强制重拉热力图
    if (e.target.closest('#staleRefresh')) { refreshHeat(true); return; }


    // 板块行 -> 板块详情
    const srow = e.target.closest('[data-board]');
    if (srow) {
      openSectorDetail(decodeURIComponent(srow.dataset.board));
      return;
    }

    // 账户资产头部：点进历史收益率
    const ah = e.target.closest('#assetHead');
    if (ah && !e.target.closest('#toggleEye')) {
      S._playEnter = true;
      S.tab = 'perf';
      render();
      loadPerf(S.perfDays);
      return;
    }

    // 收益率区间切换
    const pd = e.target.closest('[data-perfd]');
    if (pd) { loadPerf(parseInt(pd.dataset.perfd, 10)); return; }

    // K 线周期切换
    const kl = e.target.closest('[data-kline]');
    if (kl) {
      S.klineScale = parseInt(kl.dataset.kline, 10);
      render();              // 先把高亮切过去，别等网络
      loadSectorKline();
      return;
    }

    // 走势图区间切换
    const cr = e.target.closest('[data-chart]');
    if (cr) {
      S.chartRange = parseInt(cr.dataset.chart, 10);
      render();
      return;
    }

    // 发现页分段
    const dseg = e.target.closest('[data-dseg]');
    if (dseg) {
      S.discoverSeg = dseg.dataset.dseg;
      if (S.discoverSeg === 'news' && !S.news) refreshNews();
      render();
      return;
    }

    // 资讯的板块筛选
    const nsec = e.target.closest('[data-nsec]');
    if (nsec) {
      const v = nsec.dataset.nsec || '';
      S.newsSector = v ? decodeURIComponent(v) : '';
      render();
      return;
    }

    // 资产页分段
    const aseg = e.target.closest('[data-aseg]');
    if (aseg) {
      S.assetSeg = aseg.dataset.aseg;
      S.group = '全部';
      render();
      return;
    }

    const eye = e.target.closest('#toggleEye');
    if (eye) { S.hideAmount = !S.hideAmount; store.save(); render(); return; }

    // 列表末尾的「添加基金」——原顶栏那个「＋」搬家之后的落点
    if (e.target.closest('#addHold')) { openSearchSheet(); return; }

    if (e.target.closest('#predToggle')) {
      S.predictOn = !S.predictOn;
      store.save();
      render();
      if (S.predictOn) refreshPredict();
      else toast('已关闭盘中预估');
      return;
    }

    const batch = e.target.closest('#btnBatch');
    if (batch) { openBatch(); return; }

    const row = e.target.closest('.fund[data-code]');
    if (row) { openDetail(row.dataset.code); return; }

    if (e.target.closest('#detWatch')) {
      const d = S.detail;
      if (!d) return;
      if (!S.watch.some(w => w.code === d.code)) {
        S.watch.push({ code: d.code, name: d.name });
        store.save(); toast('已加入自选');
      } else toast('已在自选中');
      return;
    }
    if (e.target.closest('#detBack')) {
      S.detail = null;
      nav.back(S.detailFrom || 'hold');
      return;
    }
    if (e.target.closest('#secBack')) {
      S.sectorDetail = null;
      nav.back(S.sectorFrom || 'market');
      return;
    }
    if (e.target.closest('#miTheme')) { openThemeSheet(); return; }
    if (e.target.closest('#miDiag')) {
      S.tab = 'diag'; S.diagMode = 'check'; syncBackState(); render();
      S.diagResult = null; render();
      runDiagnostics().then(h => { S.diagResult = h; render(); });
      return;
    }
    if (e.target.closest('#miSettings')) {
      S._playEnter = true;
      S.tab = 'settings';
      syncBackState();
      render();
      return;
    }
    if (e.target.closest('#miPing')) {
      const r1 = pingLogcat();
      try {
        if (window.Native && Native.writeLogText) {
          Native.writeLogText(hhmmss() + ' T ping 文件通道测试');
        }
      } catch (err) {}
      toast('通道：' + r1);
      render();
      return;
    }
    if (e.target.closest('#miLogOn')) {
      S.logOn = !S.logOn;
      store.save();
      if (S.logOn) { diag.load(); perfMon.start(); } else { perfMon.stop(); }
      diag.info(S.logOn ? '日志已开启' : '日志已关闭');
      render();
      toast(S.logOn ? '日志已开启' : '日志已关闭');
      return;
    }
    if (e.target.closest('#miLog')) {
      S.tab = 'diag'; S.diagMode = 'log'; syncBackState(); render();
      return;
    }
    if (e.target.closest('#diagClear')) { diag.clear(); render(); return; }
    if (e.target.closest('#diagToLog')) {
      // 手动把缓冲写成 logcat，一次性输出
      const txt = diag.dump();
      try {
        if (window.Native && Native.log) {
          txt.split(String.fromCharCode(10)).slice(-80).forEach(l => Native.log(l));
          toast('已输出到 logcat');
        } else {
          toast('当前环境无 logcat');
        }
      } catch (err) { toast('输出失败'); }
      return;
    }
    if (e.target.closest('#diagCopy')) {
      try { Native.copy ? Native.copy(diag.dump()) : null; } catch (err) {}
      if (navigator.clipboard) navigator.clipboard.writeText(diag.dump()).catch(() => {});
      toast('已复制 ' + diag.buf.length + ' 条日志');
      return;
    }
    // ---- AI 校准 ----
    if (e.target.closest('#miAiCfg')) { openAiConfig(); return; }
    if (e.target.closest('#miAiOn')) {
      ai.on = !ai.on;
      render();
      toast(ai.on ? 'AI 校准已开启' : 'AI 校准已关闭');
      return;
    }
    if (e.target.closest('#miAiRun')) {
      if (!ai.on) { toast('请先开启 AI 校准'); return; }
      if (!window.Native || !Native.httpPost) { toast('当前环境不支持'); return; }
      toast('正在校准…');
      ai.runAll(true).then(n => {
        render();
        toast(n ? ('已校准 ' + n + ' 只') : '样本不足，暂不需要校准');
      }).catch(() => toast('校准失败，稍后重试'));
      return;
    }
    if (e.target.closest('#miAiInfo')) {
      const s = ai.summary();
      let body = '<h3>AI 校准状态</h3>';
      if (!s.on) {
        body += '<div class="t-dim t-sm" style="padding:8px 0">AI 校准当前是关闭的。</div>';
      } else if (s.cooling) {
        body += '<div class="t-sm" style="padding:8px 0;color:var(--accent)">连续失败 '
          + s.fails + ' 次，冷却中（还有 ' + s.coolLeft + ' 分钟）</div>';
        if (s.lastErr) body += '<div class="t-dim t-xs" style="padding-bottom:8px">'
          + s.lastErr + '</div>';
      } else if (!s.count) {
        body += '<div class="t-dim t-sm" style="padding:8px 0">还没有校准记录。'
          + '净值更新、误差样本攒够 ' + ai.MIN_SAMPLES + ' 条之后会自动跑。</div>';
      } else {
        for (const r of s.rows) {
          body += '<div style="padding:10px 0;border-top:1px solid var(--line)">'
            + '<div class="t-sm" style="font-weight:600">' + r.code
            + (r.style ? ' · ' + r.style : '') + '</div>'
            + '<div class="t-fg2 t-sm" style="margin-top:3px">' + r.diagnosis + '</div>'
            + '<div class="t-dim t-xs" style="margin-top:4px">' + r.day
            + ' · index×' + r.iw + ' holdings×' + r.hw
            + ' · 把握 ' + Math.round(r.conf * 100) + '%</div></div>';
        }
      }
      body += '<div class="t-dim t-xs" style="padding:12px 0 4px;line-height:1.6">'
        + '模型：' + s.model + '<br>'
        + 'AI 只输出权重调整建议（0.6~1.5），数值回归仍由本地算法完成。'
        + '置信度不足的建议会被直接丢弃。</div>';
      body += '<button class="btn" onclick="closeSheet()">关闭</button>';
      openSheet(body);
      return;
    }

    if (e.target.closest('#miClear')) {
      if (!confirm('确定清空全部数据？')) return;
      S.holdings = []; S.watch = []; store.save(); render();
      toast('已清空'); return;
    }
    if (e.target.closest('#miExport')) {
      const data = JSON.stringify({ holdings: S.holdings, watch: S.watch }, null, 2);
      openSheet(`<h3>导出数据</h3>
        <textarea readonly style="width:100%;height:220px;background:var(--card);
          border:1px solid var(--line);border-radius:10px;color:var(--fg);
          padding:10px;font-size:var(--fs-sm)">${data}</textarea>
        <button class="btn" onclick="closeSheet()">关闭</button>`);
      return;
    }
  });

  /*
   * 顶栏的主题切换按钮。
   *
   * 只在「浅色 ↔ 深色」之间切。当前若是「跟随系统」，就按此刻
   * **实际显示**的主题取反 —— 用户看到的是暗的，点一下当然该变亮，
   * 而不是先跳到一个叫「自动」的中间态。
   */
  const themeBtn = document.getElementById('btnTheme');
  if (themeBtn) {
    themeBtn.onclick = () => {
      const cur = theme.resolve(theme.mode);
      const next = cur === 'dark' ? 'light' : 'dark';
      theme.set(next);
      toast(next === 'dark' ? '夜间模式' : '日间模式');
    };
  }

  document.getElementById('sheet').onclick = e => {
    if (e.target.id === 'sheet') closeSheet();
  };
}

/* ---------------- 主题选择 ---------------- */
function openThemeSheet() {
  const cur = theme.mode;
  const opts = [
    { id: 'auto',  name: '跟随系统', desc: '系统切换深色时自动跟随' },
    { id: 'light', name: '浅色',     desc: '白底，白天户外更清楚' },
    { id: 'dark',  name: '深色',     desc: '深灰底，夜里不刺眼' },
  ];

  openSheet('<h3>外观主题</h3>'
    + opts.map(o =>
      '<div class="fund" data-theme-pick="' + o.id + '" style="border-radius:10px;'
      + 'margin-bottom:8px;border:1px solid '
      + (cur === o.id ? 'var(--accent)' : 'var(--line)') + '">'
      + '<div class="c0"><div class="nm">' + o.name + '</div>'
      + '<div class="amt">' + o.desc + '</div></div>'
      + '<div class="c1" style="color:var(--accent);font-weight:600">'
      + (cur === o.id ? '✓' : '') + '</div></div>').join('')
    + '<button class="btn" onclick="closeSheet()">关闭</button>');

  document.querySelectorAll('[data-theme-pick]').forEach(el => {
    el.onclick = () => {
      theme.set(el.dataset.themePick);
      openThemeSheet();       // 重开以刷新勾选
      toast('已切换为「' + theme.label(el.dataset.themePick) + '」');
    };
  });
}

/* ---------------- 弹层 ---------------- */
function openSheet(html) {
  document.getElementById('sheetBody').innerHTML = html;
  document.getElementById('sheet').classList.add('show');
  /*
   * 遮罩：CSS 里 .sheet-mask 的规则一直都在，但页面上从来没有
   * 这个元素——于是背景不压暗、点空白处也关不掉弹层，
   * 弹层背后还能继续滚动，看着像卡住了。
   */
  const mask = document.getElementById('sheetMask');
  if (mask) mask.classList.add('show');
  // 弹层开着的时候返回键应该关弹层而不是退 App，得立刻告诉原生
  syncBackState();
}
function closeSheet() {
  document.getElementById('sheet').classList.remove('show');
  const mask = document.getElementById('sheetMask');
  if (mask) mask.classList.remove('show');
  syncBackState();
}

/**
 * AI 接口配置。
 *
 * 开源版不内置任何 Key —— 谁想用谁自己填，Key 只存在本机。
 * 接口走 OpenAI 兼容协议，所以不止官方 API 能填：
 * 自建代理、本地 Ollama 的 /v1、各家云厂商的兼容端点都行。
 */
function openAiConfig() {
  const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  openSheet(
    '<h3>AI 接口配置</h3>'
    + '<div class="field"><label>API Key</label>'
    + '<input id="aiK" type="password" autocomplete="off" spellcheck="false"'
    + ' placeholder="sk-..." value="' + esc(ai.key) + '"></div>'
    + '<div class="field"><label>接口地址（OpenAI 兼容）</label>'
    + '<input id="aiU" autocomplete="off" spellcheck="false"'
    + ' placeholder="' + esc(ai.DEFAULT_URL) + '" value="' + esc(ai.url) + '"></div>'
    + '<div class="field"><label>模型名</label>'
    + '<input id="aiM" autocomplete="off" spellcheck="false"'
    + ' placeholder="' + esc(ai.DEFAULT_MODEL) + '" value="' + esc(ai.model) + '"></div>'
    + '<div class="t-dim t-xs" style="line-height:1.75;margin:6px 0 14px">'
    + 'Key 只保存在本机本地库，不上传、不外发。<br>'
    + '任何 OpenAI 兼容接口都能用：官方 API、自建代理、本地 Ollama 均可。</div>'
    + '<button class="btn primary" id="aiSave">保存</button>'
    + '<button class="btn" id="aiTest">测试连通</button>'
    + '<button class="btn" onclick="closeSheet()">取消</button>'
  );

  const read = () => ({
    k: document.getElementById('aiK').value.trim(),
    u: document.getElementById('aiU').value.trim(),
    m: document.getElementById('aiM').value.trim(),
  });

  document.getElementById('aiSave').onclick = () => {
    const v = read();
    ai.key = v.k; ai.url = v.u; ai.model = v.m;
    closeSheet(); render();
    toast(v.k ? '已保存，AI 校准可用' : '已清除 Key，AI 校准关闭');
  };

  document.getElementById('aiTest').onclick = async () => {
    const v = read();
    if (!v.k) { toast('请先填入 API Key'); return; }
    if (!window.Native || !Native.httpPost) { toast('当前环境不支持'); return; }
    /* 先落盘再测，保证测的就是要保存的那套配置 */
    ai.key = v.k; ai.url = v.u; ai.model = v.m;
    toast('正在测试连通…');
    try {
      const body = JSON.stringify({
        model: ai.model,
        messages: [{ role: 'user', content: 'reply with the single word: ok' }],
        temperature: 0,
      });
      const text = await nativeAsync(id => Native.httpPost(ai.url, body, 'Bearer ' + ai.key, id));
      const j = JSON.parse(text);
      if (j.error) throw new Error(j.error.message || 'api error');
      const c = j.choices && j.choices[0] && j.choices[0].message;
      if (!c) throw new Error('返回结构不符合 OpenAI 格式');
      toast('连通正常 · ' + ai.model);
    } catch (e) {
      toast('测试失败：' + String((e && e.message) || e).slice(0, 60));
    }
  };
}

/* ---------------- 搜索 / 添加 ---------------- */
function openSearchSheet() {
  openSheet(`
    <h3>搜索基金</h3>
    <input id="kw" placeholder="基金名称或 6 位代码，如 110011" autocomplete="off">
    <div id="results" style="margin-top:10px"></div>
    <button class="btn" onclick="closeSheet()">取消</button>
  `);
  const kw = document.getElementById('kw');
  kw.focus();
  let timer;
  kw.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = kw.value.trim();
      const box = document.getElementById('results');
      if (!q) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="empty" style="padding:20px">搜索中…</div>';
      try {
        const list = await api.search(q);
        if (!list.length) {
          box.innerHTML = '<div class="empty" style="padding:20px">无结果</div>';
          return;
        }
        box.innerHTML = list.slice(0, 15).map(f =>
          `<div class="kv t-pointer" data-code="${f.code}" data-name="${f.name}">
            <span class="k">${f.name}</span>
            <span class="v t-dim">${f.code}</span></div>`
        ).join('');
        box.querySelectorAll('[data-code]').forEach(r => {
          r.onclick = () => onPickFund(r.dataset.code, r.dataset.name);
        });
      } catch (e) {
        box.innerHTML = '<div class="empty" style="padding:20px">搜索失败</div>';
      }
    }, 320);
  };
}

async function onPickFund(code, name) {
  /*
   * 判断用户此刻在「自选」分段还是「持仓」分段。
   *
   * 原来判的是 S.tab === 'watch'，可 switchTab() 早就把 'watch'
   * 映射成了 'hold'、只把意图存进 S.assetSeg ——
   * 于是这个条件永远为假：在自选里搜基金，点结果弹出的是「添加持仓」，
   * 确认之后还真的加进了持仓列表。自选永远加不进东西。
   */
  if ((S.assetSeg || 'hold') === 'watch') {
    if (!S.watch.some(w => w.code === code)) {
      S.watch.push({ code, name });
      store.save();
    }
    closeSheet();
    await refreshNav();
    render();
    return;
  }
  openAddForm(code, name);
}

async function openAddForm(code, name) {
  let navHint = 0;
  try {
    const n = await api.navHistory(code, 1);
    if (n.length) navHint = n[0].nav;
  } catch (e) { /* ignore */ }

  // 编辑已有持仓时，把原值填回去
  const old = S.holdings.find(h => h.code === code) || null;
  const ft = fundType(name, null);
  const isMoney = ft === 'money';

  openSheet(`
    <h3>${old ? '编辑持仓' : '添加持仓'}</h3>
    <div style="color:var(--fg2);font-size:var(--fs-sm);margin-bottom:14px">
      ${name}（${code}）· ${FUND_TYPE_NAME[ft] || '混合'}</div>
    <div class="field"><label>持有份额</label>
      <input id="fShares" type="number" inputmode="decimal"
             value="${old ? old.shares : ''}"
             placeholder="如 1200.35"></div>
    <div class="field"><label>成本净值</label>
      <input id="fCost" type="number" inputmode="decimal"
             value="${old ? old.costNav : ''}"
             placeholder="${navHint ? '当前 ' + navHint : '如 1.2345'}"></div>
    <div class="field"><label>分组</label>
      <input id="fGroup" value="${old ? (old.group || '默认') : ''}"
             placeholder="默认"></div>
    ${isMoney ? `<div style="color:var(--dim);font-size:var(--fs-sm);margin:-6px 0 10px">
      货币基金净值恒为 1，收益按万份收益计算</div>` : ''}
    <div class="field"><label>分红方式</label>
      <div class="sectabs" style="margin:0">
        <button type="button" data-div="cash"
          class="${(old && old.divMode === 'cash') || !old || old.divMode !== 'reinvest' ? 'on' : ''}"
          style="flex:1">现金分红</button>
        <button type="button" data-div="reinvest"
          class="${old && old.divMode === 'reinvest' ? 'on' : ''}"
          style="flex:1">红利再投</button>
      </div>
    </div>
    <div style="color:var(--dim);font-size:var(--fs-xs);margin:-4px 0 12px">
      现金分红：钱到余额，份额不变；红利再投：自动买成份额</div>
    <div class="field"><label>买入日期（可选）</label>
      <input id="fBuyDate" type="date"
             value="${old && old.buyDate ? old.buyDate : ''}"></div>
    <div style="color:var(--dim);font-size:var(--fs-xs);margin:-4px 0 12px">
      填了才能只算买入之后的分红；不填则按成本净值自动推断</div>
    <button class="btn primary" id="fOk">确定</button>
    <button class="btn" onclick="closeSheet()">取消</button>
  `);

  // 分红方式切换
  let divMode = old && old.divMode === 'reinvest' ? 'reinvest' : 'cash';
  const box = document.getElementById('sheet');
  box.querySelectorAll('[data-div]').forEach(b => {
    b.onclick = () => {
      divMode = b.dataset.div;
      box.querySelectorAll('[data-div]').forEach(x =>
        x.classList.toggle('on', x.dataset.div === divMode));
    };
  });

  document.getElementById('fOk').onclick = async () => {
    const shares = parseFloat(document.getElementById('fShares').value);
    const cost = parseFloat(document.getElementById('fCost').value) || navHint || 1;
    const group = document.getElementById('fGroup').value.trim() || '默认';
    const buyDate = document.getElementById('fBuyDate').value || null;
    if (!shares || shares <= 0) { toast('请填写有效份额'); return; }

    const patch = { shares, costNav: cost, group, divMode, buyDate };
    const exist = S.holdings.find(h => h.code === code);
    if (exist) {
      Object.assign(exist, patch);
    } else {
      // addedAt：自动记下「什么时候开始持有的」，用不着用户填
      S.holdings.push(Object.assign({ code, name, addedAt: todayStr() }, patch));
    }

    /*
     * 记一次份额快照。
     * 新建仓、加仓、减仓都汇到这里 —— 历史收益靠它还原
     * 「那天到底持有了多少」，否则份额变化会被当成收益。
     * 清仓（份额填 0 会被上面挡掉，走删除流程）单独记录。
     */
    txLog.record(code, todayStr(), shares);

    store.save();
    closeSheet();
    await refreshNav();
    render();
    toast('已保存');
  };
}

function askNewGroup() {
  openSheet(`
    <h3>新建分组</h3>
    <div class="field"><label>分组名称</label>
      <input id="gName" placeholder="如 核心持仓"></div>
    <button class="btn primary" id="gOk">创建</button>
    <button class="btn" onclick="closeSheet()">取消</button>
  `);
  document.getElementById('gOk').onclick = () => {
    const g = document.getElementById('gName').value.trim();
    if (!g) { toast('请输入名称'); return; }
    S.group = g;
    closeSheet();
    // 进入新分组后，添加基金时会带这个分组
    toast(`已切换到「${g}」，添加基金将归入该组`);
    render();
  };
}

/* ---------------- 持仓操作菜单 ---------------- */

/** 长按持仓弹出的操作面板。 */
function openHoldMenu(h) {
  const pinned = h.pinned ? '取消置顶' : '置顶';
  const groups = ['全部', ...new Set(S.holdings.map(x => x.group || '默认'))]
    .filter(g => g !== '全部');

  openSheet(
    '<h3>' + (h.name || h.code) + '</h3>'
    + '<div style="color:var(--fg2);font-size:var(--fs-sm);margin:-8px 0 14px">'
    + h.code + ' · 持有 ' + fmt(h.shares, 2) + ' 份 · 成本 ' + fmt(h.costNav, 4)
    + '</div>'

    + menuRow('edit', '编辑份额与成本', '修改持有数量、成本净值')
    + menuRow('group', '移动到分组', (h.group || '默认'))
    + menuRow('pin', pinned, h.pinned ? '已置顶在列表最前' : '固定在列表最前')
    + menuRow('watch', '加入自选', '在自选页也能看到')
    + menuRow('del', '删除这只持仓', '只删本地记录，不影响账户', true)
    + '<button class="btn" onclick="closeSheet()">取消</button>'
  );

  bindMenu('edit', () => { closeSheet(); openEditForm(h); });
  bindMenu('group', () => { closeSheet(); openGroupPicker(h, groups); });
  bindMenu('pin', () => {
    h.pinned = !h.pinned;
    store.save(); closeSheet(); render();
    toast(h.pinned ? '已置顶' : '已取消置顶');
  });
  bindMenu('watch', () => {
    if (!S.watch.some(w => w.code === h.code)) {
      S.watch.push({ code: h.code, name: h.name });
      store.save();
      toast('已加入自选');
    } else {
      toast('已在自选中');
    }
    closeSheet();
  });
  bindMenu('del', () => { closeSheet(); confirmDelete(h); });
}

/** 长按自选弹出的操作面板。 */
function openWatchMenu(w) {
  openSheet(
    '<h3>' + (w.name || w.code) + '</h3>'
    + '<div style="color:var(--fg2);font-size:var(--fs-sm);margin:-8px 0 14px">'
    + w.code + '</div>'
    + menuRow('detail', '查看详情', '净值走势与重仓股')
    + menuRow('hold', '加入持仓', '填写份额与成本')
    + menuRow('del', '从自选删除', '', true)
    + '<button class="btn" onclick="closeSheet()">取消</button>'
  );

  bindMenu('detail', () => { closeSheet(); openDetail(w.code); });
  bindMenu('hold', () => { closeSheet(); openAddForm(w.code, w.name); });
  bindMenu('del', () => {
    S.watch = S.watch.filter(x => x.code !== w.code);
    store.save(); closeSheet(); render(); toast('已从自选删除');
  });
}

function menuRow(key, title, sub, danger) {
  return '<div class="fund" data-menu="' + key + '" style="border-radius:10px;'
    + 'margin-bottom:8px;border:1px solid var(--line)">'
    + '<div class="c0"><div class="nm"' + (danger ? ' class="t-up"' : '')
    + '>' + title + '</div>'
    + (sub ? '<div class="amt">' + sub + '</div>' : '') + '</div>'
    + '<div class="c1 t-dim">›</div></div>';
}

function bindMenu(key, fn) {
  const el = document.querySelector('[data-menu="' + key + '"]');
  if (el) el.onclick = fn;
}

/** 删除确认：给出明确后果，避免误触。 */
function confirmDelete(h) {
  openSheet(
    '<h3>删除持仓</h3>'
    + '<div style="color:var(--fg2);font-size:var(--fs-md);line-height:1.7;'
    + 'margin-bottom:16px">确定删除「' + (h.name || h.code) + '」？'
    + '<br><span style="color:var(--dim);font-size:var(--fs-sm)">'
    + '只会删除本机的持仓记录，不会影响你的基金账户。</span></div>'
    + '<button class="btn" id="delOk" style="background:var(--up);color:#fff">'
    + '删除</button>'
    + '<button class="btn" onclick="closeSheet()">取消</button>'
  );
  document.getElementById('delOk').onclick = () => {
    S.holdings = S.holdings.filter(x => x.code !== h.code);
    delete S.predict[h.code];
    store.save(); closeSheet(); render(); toast('已删除');
  };
}

/** 分组选择。 */
function openGroupPicker(h, groups) {
  openSheet(
    '<h3>移动到分组</h3>'
    + groups.map(g => '<div class="fund" data-pick-group="' + g + '"'
      + ' style="border-radius:10px;margin-bottom:8px;border:1px solid '
      + ((h.group || '默认') === g ? 'var(--accent)' : 'var(--line)') + '">'
      + '<div class="c0"><div class="nm">' + g + '</div></div>'
      + '<div class="c1 t-accent">'
      + ((h.group || '默认') === g ? '✓' : '') + '</div></div>').join('')
    + '<div class="field"><label>或新建分组</label>'
    + '<input id="newGroup" placeholder="输入分组名"></div>'
    + '<button class="btn primary" id="grpNew">新建并移入</button>'
    + '<button class="btn" onclick="closeSheet()">取消</button>'
  );

  document.querySelectorAll('[data-pick-group]').forEach(el => {
    el.onclick = () => {
      h.group = el.dataset.pickGroup;
      store.save(); closeSheet(); render();
      toast('已移动到「' + h.group + '」');
    };
  });
  document.getElementById('grpNew').onclick = () => {
    const g = (document.getElementById('newGroup').value || '').trim();
    if (!g) { toast('请输入分组名'); return; }
    h.group = g;
    store.save(); closeSheet(); render();
    toast('已移动到「' + g + '」');
  };
}

/* ---------------- 批量管理 ---------------- */
function openBatch() {
  if (!S.holdings.length) { toast('暂无持仓'); return; }
  openSheet(`
    <h3>批量管理</h3>
    ${S.holdings.map((h, i) => `<div class="kv">
      <span class="k">${h.name || h.code}</span>
      <span class="v">
        <button class="chip" data-edit="${i}" style="margin-right:6px">编辑</button>
        <button class="chip t-up" data-del="${i}">删除</button>
      </span></div>`).join('')}
    <button class="btn" onclick="closeSheet()">关闭</button>
  `);
  document.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = () => {
      S.holdings.splice(parseInt(b.dataset.del, 10), 1);
      store.save(); closeSheet(); render(); toast('已删除');
    };
  });
  document.querySelectorAll('[data-edit]').forEach(b => {
    b.onclick = () => {
      const h = S.holdings[parseInt(b.dataset.edit, 10)];
      closeSheet();
      openEditForm(h);
    };
  });
}

function openEditForm(h) {
  openSheet(`
    <h3>编辑持仓</h3>
    <div style="color:var(--fg2);font-size:var(--fs-sm);margin-bottom:14px">
      ${h.name}（${h.code}）</div>
    <div class="field"><label>持有份额</label>
      <input id="eShares" type="number" inputmode="decimal" value="${h.shares}"></div>
    <div class="field"><label>成本净值</label>
      <input id="eCost" type="number" inputmode="decimal" value="${h.costNav}"></div>
    <div class="field"><label>分组</label>
      <input id="eGroup" value="${h.group || '默认'}"></div>
    <button class="btn primary" id="eOk">保存</button>
    <button class="btn" onclick="closeSheet()">取消</button>
  `);
  document.getElementById('eOk').onclick = () => {
    h.shares = parseFloat(document.getElementById('eShares').value) || h.shares;
    h.costNav = parseFloat(document.getElementById('eCost').value) || h.costNav;
    h.group = document.getElementById('eGroup').value.trim() || '默认';
    store.save(); closeSheet(); render(); toast('已保存');
  };
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  /*
   * 先把本地库打开，再读任何数据。
   *
   * db.open() 内部保证**不抛异常** —— IndexedDB 打不开（隐私模式、
   * 配额被拒）就整体退回 localStorage，功能不减，只是容量回到老样子。
   * 所以这一步不会挡住启动。
   *
   * 顺序不能反：db.open() 决定内存里有没有数据，
   * 而 store.load() / beta.load() 都是同步读内存的。
   */
  await db.open();

  store.load();
  // 有买入日/加入日期的持仓，这里当场就能建上流水基线；
  // 其余等 refreshNav 拉到净值历史后按成本价反推
  try { ensureTxBaseline(); } catch (e) { /* 忽略 */ }
  beta.load();                      // β 回归样本
  theme.apply(theme.mode, false);   // 首帧前已由 head 内联脚本定好，这里只是同步状态
  theme.watch();
  bindGlobal();

  // 拼多多式首屏：先用本地缓存立刻渲染，网络数据随后无缝替换。
  // 冷启动时用户第一眼就能看到内容，而不是「加载中」。
  hydrateFromCache();
  render();

  /*
   * 每次打开 App 强制刷新一遍，用户看到的不会是很久以前的快照。
   * 缓存只负责「第一眼有东西看」，随后的网络数据会覆盖它。
   */
  syncTimeAtBoot();

  diag.info('启动 · ' + (window.Native ? '原生环境' : '浏览器预览')
    + ' · 持仓 ' + S.holdings.length + ' 只');

  // 启动日志立刻推一次，保证 logcat 马上能看到现场
  setTimeout(() => { try { diag._flush(); } catch (e) {} }, 300);

  perfMon.start();      // 性能采样（仅日志开启时运行）

  pull.init();          // 所有页面的下拉刷新
  swipe.init();         // 主 tab 左右滑动切换
  await refreshAll(true);

  /*
   * 刷新节奏。
   *
   * 之前是写死 3 秒全量刷一次，代价很大：每 3 秒把整页 innerHTML 重建一遍，
   * 滚动位置会跳、界面会闪，电量也扛不住。
   *
   * 现在分三档：
   *   盘中   25 秒刷一次估值与预估（盘中数据本来就在变）
   *   收盘后 3 分钟兜底刷一次（净值一天只出一次，刷快了没意义）
   *   不可见 完全不刷（切到后台就停，回来时立即补一次）
   */
  /*
   * 定时刷新。
   *
   * 所有定时器第一件事都是判断 document.hidden：
   * 页面不可见时直接返回，一个请求都不发、一次渲染都不做。
   * 这不只是省流量——后台空转会让 WebView 持续占用 CPU 和 GPU，
   * 是耗电的主要来源之一。
   */
  setInterval(() => {
    if (document.hidden) return;
    if (!isTradingNow()) return;
    // 只有资产页才需要盘中预估，其他页面刷了也没人看
    if (S.tab !== 'hold') return;
    refreshPredict();
  }, 30000);

  setInterval(() => {
    if (document.hidden) return;
    if (!isTradingNow()) return;
    if (S.tab !== 'hold' && S.tab !== 'market') return;
    refreshIndices().then(render);
  }, 60000);

  // 净值一天只变一次，兜底频率可以很低
  setInterval(() => {
    if (document.hidden) return;
    refreshNav().then(render);
  }, 300000);

  // 热力图只在行情页看的时候才拉
  setInterval(() => {
    if (document.hidden) return;
    if (S.tab !== 'market' && S.tab !== 'sectorDetail') return;
    refreshHeat();
  }, 20000);

  // 每小时重新对齐：手机时钟被改动后能自动跟上
  setInterval(() => { syncTimeAtBoot(); }, 3600000);

  /*
   * 从后台切回前台时补一次刷新。
   *
   * 两个入口（WebView 的 visibilitychange + 原生的 onResume）
   * 会几乎同时触发，加上启动期间 WebView 自己的可见性抖动，
   * 日志里能看到同一秒跑完两轮完整刷新。
   *
   * 用一个共享的防抖：800ms 内的多次触发只执行最后一次。
   * 放在这比在 refreshAll 里做节流更准，因为要压的是「触发事件」，
   * 而不是「刷新动作」。
   */
  let resumeTimer = null;
  const scheduleResume = () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      refreshAll(false);
    }, 800);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { perfMon.stop(); return; }
    if (S.logOn) perfMon.start();
    scheduleResume();
  });

  // 原生侧回到前台也会触发（部分机型 WebView 的 visibilitychange 不触发）
  window.__onAppResume = () => scheduleResume();
})();
