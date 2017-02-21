/*
    D3 TreeView Widget
    ========================

    @file      : D3TreeView.js
    @version   : 1.0.0
    @author    : Ivo Sturm
    @date      : 29-01-2017
    @copyright : First Consulting
    @license   : Apache 2

    Documentation
    ========================
    Add a collapsible, zoomable, drag- and droppable and clickable TreeView widget to your Mendix page.
	
	Known bugs
	========================
	When collapsing and expanding quickly after eachother, the nodes circles do not come back.
	
	Versions
	========================
	v1.1 - Fix for when context entity is updated, was not properly refreshing. Changed _cleanDomNode function not to clear the svg-tree container which holds the full TreeView + 	the added HTML Button Container div. See widget/template/D3TreeView.html for changes as well.
		 - Added Centralize On Click setting which defaults to No. 
	v1.2 - Added possibility for on click MF trigger on root node. 
*/

// Required module list. Remove unnecessary modules, you can always get them back from the boilerplate.
define([
    "dojo/_base/declare",
    "mxui/widget/_WidgetBase",
    "dijit/_TemplatedMixin",
    "mxui/dom",
    "dojo/dom",
	"dojo/on",
    "dojo/dom-style",
    "dojo/_base/array",
    "dojo/_base/lang",
    "dojo/text!D3TreeView/widget/template/D3TreeView.html",
    "D3TreeView/lib/d3-v3-min"
], function(declare, _WidgetBase, _TemplatedMixin, dom, dojoDom, on, dojoStyle, dojoArray, dojoLang,  widgetTemplate) {
    "use strict";
	// d3 is added to the window, so redefine it for programming convenience
	var d3 = window.d3;
    // Declare widget's prototype.
    return declare("D3TreeView.widget.D3TreeView", [ _WidgetBase, _TemplatedMixin ], {
        // _TemplatedMixin will create our dom node using this HTML template.
        templateString: widgetTemplate,

        // DOM elements
        svgTree: null,

        // Internal variables. Non-primitives created in the prototype are shared between all widget instances.
        _handles: null,
        _contextObj: null,
		_progressID   : null,
		_totalNodes : 0,
		_maxLabelLength : 0,
		_selectedNode : null,
		_draggingNode : null,
		_panSpeed : 200,
		_panBoundary : 20, 
		_i : 0,

        // dojo.declare.constructor is called to construct the widget instance. Implement to initialize non-primitive properties.
        constructor: function() {

            logger.debug(this.id + ".constructor");
            this._handles = [];
			this._root = null;
			this._tree = null;
			this._svgGroup = null;
			this._dragListener = null;
			this._zoomListener = null;
			this._diagonal = null;
			this._dragStarted = null;
			this._nodes = null;
			this._links = null;
			this._panTimer = null;
			this._treeData = [];
			this._nodeObjects = [];
			this._viewerMinHeight = 0;
			this._viewerMinWidth = 0;
			this._intialLoad = true;
        },

        // dijit._WidgetBase.postCreate is called after constructing the widget. Implement to do extra setup work.
        postCreate: function() {

			this._parentReferenceName = this.parentReference.substr(0, this.parentReference.indexOf('/'));
            this._setupEvents();
        },

        // mxui.widget._WidgetBase.update is called when context is changed or initialized. Implement to re-render and / or fetch data.
        update: function(obj, callback) {

            this._contextObj = obj;
            this._resetSubscriptions();
            this._updateRendering(this._contextObj);

            if (typeof callback !== "undefined") {
              callback();
            }
        },


        _drawChart: function(objs) {
			
			if (objs){
				// fill global array, so it can be used later on to store the changes
				this._nodeObjects = objs;
				// create objects with reference to parent
				for (var j=0 ; j < objs.length ; j++){
					var treeObj = {};
					treeObj.name = objs[j].get(this.nameAttr);
					treeObj.guid = objs[j].getGuid();
					treeObj.parentGuid = objs[j].getReference(this._parentReferenceName);
					// set children as empty array for now. In second loop fill based on parentGuid
					treeObj.children = [];
					this._treeData.push(treeObj);

				}
				// now set children based on parentGuids
				for (var k=0 ; k < this._treeData.length ; k++){
					if (this._treeData[k].parentGuid){
						var parentObj = this._treeData.filter(dojoLang.hitch(this,function(e) {
						  return e.guid == this._treeData[k].parentGuid;
						}));
						// filter operation gives back a list, but since guid is unique we can take the first
						if (parentObj[0] && parentObj[0].children){
							parentObj[0].children.push(this._treeData[k]);
						}
					}				
				}
				
			}
			
			this._tree = d3.layout.tree()
				.size([this._viewerHeight, this._viewerWidth]);

			// define a d3 diagonal projection for use by the node paths later on.
			this._diagonal = d3.svg.diagonal()
				.projection(function(d) {
					return [d.y, d.x];
				});			

			// filter operation gives back a list, but since only one node should be the topparent with no parents itself, we can take the first
			var treeData = this._treeData.filter(dojoLang.hitch(this,function(e) {
				return e.parentGuid === "";
			}))[0];
			
			// if data fed to widget, setup the tree
			if (treeData){
				// call visit function to establish maxLabelLength
				this._visit(treeData, dojoLang.hitch(this,function(d) {
					this._totalNodes++;
					this._maxLabelLength = Math.max(d.name.length, this._maxLabelLength);

				}), function(d) {
					return d.children && d.children.length > 0 ? d.children : null;
				});
				// make width a bit more concise, therefore take 80 % of maximum label as base of length for all links
				this._maxLabelLength = 0.8 * this._maxLabelLength;
				// Sort the tree initially in case the JSON isn't in a sorted order.
				this._sortTree();			

				// define the zoomListener which calls the zoom function on the "zoom" event constrained within the scaleExtents
				this._zoomListener = d3.behavior.zoom().scaleExtent([0.1, 3]).on("zoom", dojoLang.hitch(this,function(){this._zoom();}));
				
				// create svg element
				var baseSvg;
				
				// position svg element relative to buttons
				if (this._buttonsBelow){
					baseSvg = d3.select("#tree-container").insert("svg",":first-child");
				} else {
					baseSvg = d3.select("#tree-container").append("svg");
				}
				
				// attaching a class for styling and the zoomListener to svg element
				baseSvg
					.attr("width", this._viewerWidth)
					.attr("height", this._viewerHeight)
					.attr("class", "overlay")
					.style("display","inherit") // needed to properly position buttons for collapse and expand above the SVG element itself
					.style("background-color",this._backgroundColor)
					.call(this._zoomListener);					
				
				// Append a group which holds all nodes to the full length and breadth of SVG to capture the zoom events.
				this._svgGroup = baseSvg.append("g")
					.attr("class", "svg-group")
					.style("pointer-events", "all");
									
				// Define the root
				this._root = treeData;
				
				// add extra spacing horizontally based on length of text of rootelement
				this._rootOffsetX = (this._root.name.length / 0.6) * 6;
				// add extra spacing vertically for margin on top and bottom
				this._rootOffsetY = 20;
				
				this._root.x0 = this._viewerHeight / 2;
				this._root.y0 = 0;
			
				// initialize layout of tree
				this._expand(this._root);
					
				// reposition root based on offsets
				d3.select('g').transition()
					.duration(this.duration)
					.attr("transform", "translate(" + this._rootOffsetX + "," + this._rootOffsetY + ")");
			}
			
			this._hideProgress();
			// once loaded, do not resize SVG element anymore, hence set this._initialLoad to false
			this._intialLoad=false;
        },

        // rerender the interface.
        _updateRendering: function(obj) {

            // draw and attach event handlers only first time when this._tree is not populated yet
            if (obj !== null && this._treeData.length === 0) {
				this._showProgress();
				this._loadTreeData();
            } else if (obj !== null && this._treeData.length > 0){
				// only redraw
				this._expand(this._root);
			} 
        },

        // Reset subscriptions.
        _resetSubscriptions: function () {

            var _objectHandle = null;

            // Release handles on previous object, if any.
            if (this._handles) {
                dojoArray.forEach(this._handles, function (handle, i) {
                    mx.data.unsubscribe(handle);
                });
                this._handles = [];
            }

            // When a mendix object exists create subscriptions.
            if (this._contextObj) {
                _objectHandle = this.subscribe({
                    guid: this._contextObj.getGuid(),
                    callback: dojoLang.hitch(this, function (guid) {
						if (this.loggingEnabled){
							console.log(this.id + "update on entity with guid: " + guid);
						}
						// reset _initialLoad, since it will trigger a resize of the widget based on the height it needs
						this._intialLoad = true;
						// empty stored treeData of previous version of context object
						this._treeData = [];
						this._showProgress();
                        this._cleanUpDomNode(this.svgTree,this._loadTreeData());
                    })
                });

                this._handles = [];

            }
        },
		// HELPER FUNCTIONS
		// A recursive helper function for performing some setup by walking through all nodes
		_visit : function(parent, visitFn, childrenFn) {
			if (!parent) return;

			visitFn(parent);

			var children = childrenFn(parent);
			if (children) {
				var count = children.length;
				for (var i = 0; i < count; i++) {
					this._visit(children[i], visitFn, childrenFn);
				}
			}
		},
		// Function to center node when clicked/dropped so node doesn't get lost when collapsing/moving with large amount of children.
		_centerNode : function(source) {

			var scale = this._zoomListener.scale();
			var x = -source.y0;
			var y = -source.x0;
			x = x * scale + this._viewerWidth / 2;
			y = y * scale + this._viewerHeight / 2;
			d3.select('g').transition()
				.duration(this.duration)
				.attr("transform", "translate(" + x + "," + y + ")scale(" + scale + ")");
			this._zoomListener.scale(scale);
			this._zoomListener.translate([x, y]);
		},
		// Toggle children function
		_toggleChildren : function(d) {
			if (d && d.children) {
				d._children = d.children;
				d.children = null;
			} else if (d && d._children) {
				d.children = d._children;
				d._children = null;
			}
			return d;
		},  
		// Toggle children on click.
		_click : function(d) { 
			if (d3.event && d3.event.defaultPrevented) return; // click suppressed
			d = this._toggleChildren(d);
			if (d){
				this._updateTree(d);
				if (this.centralizeOnClick){
					this._centerNode(d);
				}
			}
		},
		_updateTree : function(source) {
			// Compute the new height, function counts total children of root node and sets tree height accordingly.
			// This prevents the layout looking squashed when new nodes are made visible or looking sparse when nodes are removed
			// This makes the layout more consistent.
			var levelWidth = [1];
			var childCount = function(level, n) {

				if (n.children && n.children.length > 0) {
					if (levelWidth.length <= level + 1) levelWidth.push(0);

					levelWidth[level + 1] += n.children.length;
					n.children.forEach(function(d) {

						childCount(level + 1, d);
					});
				}
			};

			childCount(0, this._root);

			var newHeight = d3.max(levelWidth) * this._verticalNodeDistance; // x pixels per line  
			this._tree = this._tree.size([newHeight, this._viewerWidth]);

			// Compute the new tree layout.
			this._nodes = this._tree.nodes(this._root).reverse(),
			this._links = this._tree.links(this._nodes);

			// Set widths between levels based on maxLabelLength.
			this._nodes.forEach(dojoLang.hitch(this,function(d) {
				d.y = (d.depth * (this._maxLabelLength * this._horizontalNodeDistance)); 
			}));

			// Update the nodes…
			var node = this._svgGroup.selectAll("g.node")
				.data(this._nodes, dojoLang.hitch(this,function(d) {
					return d.id || (d.id = ++this._i);
				}));

			// Enter any new nodes at the parent's previous position.
			var nodeEnter = node.enter().append("g")
				.call(this._dragListener)
				.attr("class", "node")
				.attr("transform", function(d) {
					return "translate(" + source.y0 + "," + source.x0 + ")";
				})
				.attr("id", function(d) {
					return "node_" + d.guid;
				})
				.on('click', dojoLang.hitch(this,function(d) {
					// block collapse & expand behavior when onClickMF is defined
					if (!this.onClickMF){
						this._click(d);
					}
				}));

			nodeEnter.append("circle")
				.attr('class', 'nodeCircle')
				.attr("r", 0)
				.style("fill", dojoLang.hitch(this, function(d) {
					return  d.children ? "lightsteelblue" : "#fff";
				}))
				.style("stroke", this.nodeStrokeColor)
				.style("stroke-width", this.nodeStrokeWidth);

			nodeEnter.append("text")
				.attr("x", function(d) {
					return d.children || d._children ? -10 : 10;
				})
				.attr("dy", ".35em")
				.attr('class', 'nodeText')
				.attr("text-anchor", function(d) {
					return d.children || d._children ? "end" : "start";
				})
				.text(function(d) {
					return d.name;
				})
				.style("fill-opacity", 0)
				.style("font-size", this.fontSize + "px")
				.style("font-color", this.fontColor + "px");

			// ghost node to give us mouseover in a radius around it
			nodeEnter.append("circle")
				.attr('class', 'ghostCircle')
				.attr("r", 3 * this.nodeRadius)
				.attr("opacity", 0.2) // change this to zero to hide the target area
			.style("fill", this.ghostNodeColor)
				.attr('pointer-events', 'mouseover')
				.on("mouseover", dojoLang.hitch(this,function(node) {
					this._overCircle(node);
				}))
				.on("mouseout", dojoLang.hitch(this,function(node) {
					this._outCircle(node);
				}));

			// Update the text to reflect whether node has children or not.
			node.select('text')
				.attr("x", function(d) {
					return d.children || d._children ? -10 : 10;
				})
				.attr("text-anchor", function(d) {
					return d.children || d._children ? "end" : "start";
				})
				.text(function(d) {
					return d.name;
				});

			// Change the circle fill depending on whether it has children
			node.select("circle.nodeCircle")
				.attr("r", this.nodeRadius)
				.style("fill", function(d) {
				return d.children || d._children ? "lightsteelblue" : "#fff";
				});

			// Transition nodes to their new position.
			var nodeUpdate = node.transition()
				.duration(this.duration)
				.attr("transform", function(d) {
					return "translate(" + d.y + "," + d.x + ")";
				});

			// Fade the text in
			nodeUpdate.select("text")
				.style("fill-opacity", 1);

			// Transition exiting nodes to the parent's new position.
			var nodeExit = node.exit().transition()
				.duration(this.duration)
				.attr("transform", function(d) {
					return "translate(" + source.y + "," + source.x + ")";
				})
				.remove();

			nodeExit.select("circle")
				.attr("r", 0);

			nodeExit.select("text")
				.style("fill-opacity", 0);

			// Update the links…
			var link = this._svgGroup.selectAll("path.link")
				.data(this._links, function(d) {
					return d.target.id;
				});

			// Enter any new links at the parent's previous position.
			link.enter().insert("path", "g")
				.attr("class", "link")
				.style("stroke", this.linkStrokeColor)
				.attr("d", dojoLang.hitch(this,function(d) {
					var o = {
						x: source.x0,
						y: source.y0
					};
					return this._diagonal({
						source: o,
						target: o
					});
				}));
				
			// Transition links to their new position.
			link.transition()
				.duration(this.duration)
				.attr("d", this._diagonal);

			// Transition exiting nodes to the parent's new position.
			link.exit().transition()
				.duration(this.duration)
				.attr("d", dojoLang.hitch(this, function(d) {
					var o = {
						x: source.x,
						y: source.y
					};
					return this._diagonal({
						source: o,
						target: o
					});
				}))
				.remove();

			// determine the maximum width of the SVG element by iterating through nodes and checking coordinates 
			this._maxWidth = 0;
			this._nodes.forEach(dojoLang.hitch(this,function(d,i) {
				d.x0 = d.x;
				d.y0 = d.y;
				if (this._viewerMinHeight === 0){
					this._viewerMinHeight = d.x;
				} else {
					if (d.x < this._viewerMinHeight){
						this._viewerMinHeight = d.x;
					}
				}
				if (this._viewerMinWidth === 0){
					this._viewerMinWidth = d.y;
				} else {
					if (d.y < this._viewerMinWidth){
						this._viewerMinWidth = d.y;
					}
				}
				
				if (d.x > this._viewerHeight){
					this._viewerHeight = d.x;
				}
				if (d.y > this._maxWidth){
					this._maxWidth = d.y;
					this._rightmostNode = d.y;
				}
			}));
			// update size of tree
			this._tree
				.size([this._viewerHeight + 2 * this._rootOffsetY,this._maxWidth + this._rootOffsetX]);
			
			if (this._intialLoad){
				// update size of svg group
				d3.select("#tree-container svg")
					.attr("width", this._rightmostNode + ((this._maxLabelLength * 20)))
					.attr("height", this._viewerHeight + 2 * this._rootOffsetY);
			}
			if (this.loggingEnabled){
				console.log("calculated maxHeight based on tree: " + this._viewerHeight);
				console.log("calculated maxWidth based on tree: " + this._maxWidth);
				console.log("calculated minHeight based on tree: " + this._viewerMinHeight);
				console.log("calculated minWidth based on tree: " + this._viewerMinWidth);
			}
				
		},   
		_endDrag : function(domNode) {
			this._selectedNode = null;
			d3.selectAll('.ghostCircle').attr('class', 'ghostCircle');
			d3.select(domNode).attr('class', 'node');
			// now restore the mouseover event or we won't be able to drag a 2nd time
			d3.select(domNode).select('.ghostCircle').attr('pointer-events', '');
			this._updateTempConnector();
			if (this._draggingNode !== null) {
				this._updateTree(this._root);
				this._centerNode(this._draggingNode);
				this._draggingNode = null;
			}
		},
		// Helper functions for collapsing and expanding all nodes.
		_collapse : function(d) {
			if (d.children) {
				d._children = d.children;
				d._children.forEach(dojoLang.hitch(this,function(i){this._collapse(i);}));
				d.children = [];
			}
			if (d){
				this._updateTree(d);
			}
		},
		_expand : function(d) {

			if (d._children) {
				d.children = d._children;
				d.children.forEach(dojoLang.hitch(this,function(i){this._expand(i);}));
			}
			if (d){
				this._updateTree(d);
			}
		},
		_initiateDrag : function(d, domNode) {
			this._draggingNode = d;
			d3.select(domNode).select('.ghostCircle').attr('pointer-events', 'none');
			d3.selectAll('.ghostCircle').attr('class', 'ghostCircle show');
			d3.select(domNode).attr('class', 'node activeDrag');

			this._svgGroup.selectAll("g.node").sort(dojoLang.hitch(this,function(a, b) { // select the parent and sort the path's
				if (a.id != this._draggingNode.id) return 1; // a is not the hovered element, send "a" to the back
				else return -1; // a is the hovered element, bring "a" to the front
			}));
			
			// if nodes has children, remove the links and nodes
			if (d.children && d.children.length > 1) {
				
				// get all links connecting children of node being dragged
				var links = this._tree.links(this._tree.nodes(d));
				// remove those links from sight
				this._svgGroup.selectAll("path.link")
					.data(links, function(d) {
						return d.target.id;
					}).remove();
				// remove child nodes as well
				this._svgGroup.selectAll("g.node")
					.data(this._tree.nodes(d), function(d) {
						return d.id;
					}).filter(dojoLang.hitch(this,function(d, i) {

						if (d.id == this._draggingNode.id) {
							return false;
						}
						return true;
					})).remove();
			}

			// remove parent link
			this._svgGroup.selectAll('path.link').filter(dojoLang.hitch(this,function(d, i) {

				if (d.target.id == this._draggingNode.id) {
					return true;
				}
				return false;
			})).remove();

			this._dragStarted = null;
		},
		_pan : function(domNode, direction) {
			var translateX,
			translateY;
			var speed = this._panSpeed;
			if (this._panTimer) {
				clearTimeout(this._panTimer);
				var translateCoords = d3.transform(this._svgGroup.attr("transform"));
				if (direction == 'left' || direction == 'right') {
					translateX = direction == 'left' ? translateCoords.translate[0] + speed : translateCoords.translate[0] - speed;
					translateY = translateCoords.translate[1];
				} else if (direction == 'up' || direction == 'down') {
					translateX = translateCoords.translate[0];
					translateY = direction == 'up' ? translateCoords.translate[1] + speed : translateCoords.translate[1] - speed;
				}
				var scale = this._zoomListener.scale();
				this._svgGroup.transition().attr("transform", "translate(" + translateX + "," + translateY + ")scale(" + scale + ")");
				d3.select(domNode).select('g.node').attr("transform", "translate(" + translateX + "," + translateY + ")");
				this._zoomListener.scale(this._zoomListener.scale());
				this._zoomListener.translate([translateX, translateY]);
				this._panTimer = setTimeout(function() {
					this._pan(domNode, speed, direction);
				}, 50);
			}
		},
		_zoom : function() {
			if (this.zoomEnabled){
				if (this._svgGroup){
					this._svgGroup.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
				}
			} 
		},		
		// sort the tree according to the node names
		_sortTree : function() {
			this._tree.sort(function(a, b) {
				return b.name.toLowerCase() < a.name.toLowerCase() ? 1 : -1;
			});
		},
		// define the drag listeners for drag/drop behaviour of nodes.
		_setupEvents : function(){
			// if drag and drop is disabled only call expand / collapse behavior
			// a drag event is also triggered when clicking. 
			this._dragListener = d3.behavior.drag()
				.on("dragstart", dojoLang.hitch(this,function(d) {
					if (d == this._root && !this.onClickMF) {
						return;
					}
					this._dragStarted = true;
					d3.event.sourceEvent.stopPropagation();
					if (this.onClickMF && d){
						this._execMF(d);
					}
				}));
			
			if (this.dragDropEnabled){
				// DRAG AND DROP
				// also add dragstart and dragend events
				this._dragListener = this._dragListener
					.on("drag", dojoLang.hitch(this,function(d) {

						if (d == this._root) {
							return;
						}
						if (this._dragStarted) {

							var domNode = document.getElementById("node_" + d.guid);
							this._initiateDrag(d, domNode);
						}

						// get coords of mouseEvent relative to svg container to allow for panning
						var svgNode = document.getElementsByClassName('overlay')[0];
						var relCoords = d3.mouse(svgNode);
						if (relCoords[0] < this._panBoundary) {
							this._panTimer = true;
							this._pan(this, 'left');
						} else if (relCoords[0] > (svgNode.width - this._panBoundary)) {

							this._panTimer = true;
							this._pan(this, 'right');
						} else if (relCoords[1] < this._panBoundary) {
							this._panTimer = true;
							this._pan(this, 'up');
						} else if (relCoords[1] > (svgNode.height - this._panBoundary)) {
							this._panTimer = true;
							this._pan(this, 'down');
						} else {
							try {
								clearTimeout(this._panTimer);
							} catch (e) {

							}
						}

						d.x0 += d3.event.dy;
						d.y0 += d3.event.dx;

						var node = d3.select("node_" + d.guid);
						node.attr("transform", "translate(" + d.y0 + "," + d.x0 + ")");
						this._updateTempConnector();
					})).on("dragend", dojoLang.hitch(this,function(d) {
						if (d == this._root) {
							return;
						}
						var domNode = document.getElementById("node_" + d.guid);
						if (this._selectedNode) {
							// now remove the element from the parent, and insert it into the new elements children
							var index = this._draggingNode.parent.children.indexOf(this._draggingNode);
							if (index > -1) {
								this._draggingNode.parent.children.splice(index, 1);
							}
							if (typeof this._selectedNode.children !== 'undefined' || typeof this._selectedNode._children !== 'undefined') {
								if (typeof this._selectedNode.children !== 'undefined') {
									this._selectedNode.children.push(this._draggingNode);
								} else {
									this._selectedNode._children.push(this._draggingNode);
								}
							} else {
								this._selectedNode.children = [];
								this._selectedNode.children.push(this._draggingNode);
							}
							// Make sure that the node being added to is expanded so user can see added node is correctly moved
							this._expand(this._selectedNode);
							this._sortTree();
							this._endDrag(domNode);
						} else {
							this._endDrag(domNode);
						}
					}));
				
				// SAVE NODE CHANGES
				on(this.svgBtnSaveNodes,"click", dojoLang.hitch(this,function(){
						this._saveChanges(this._root);
				}));	
				this.svgBtnSaveNodes.innerHTML += this._saveBtnText;	
			} else {
				// if drag and drop disabled, do not show save button
				this.svgBtnSaveNodes.style.display = "none";
			} 	
			if (this.collapseExpandAllEnabled){	
					
				// COLLAPSE ALL
				this.svgBtnCollapseAll.innerHTML += this._collapeAllBtnText;
				on(this.svgBtnCollapseAll,"click", dojoLang.hitch(this,function(){
						this._collapse(this._root);
				}));
				
				// EXPAND ALL
				this.svgBtnExpandAll.innerHTML += this._expandAllBtnText;	
				on(this.svgBtnExpandAll,"click", dojoLang.hitch(this,function(){
						this._expand(this._root);
				}));
			} else {
				// if collapse and expand all disabled, do not show buttons
				this.svgBtnCollapseAll.style.display = "none";
				this.svgBtnExpandAll.style.display = "none";
			}		
		},
		// Function to update the temporary connector indicating dragging affiliation
		_updateTempConnector : function() {
			var data = [];
			if (this._draggingNode !== null && this._selectedNode !== null) {
				// have to flip the source coordinates since we did this for the existing connectors on the original tree
				data = [{
					source: {
						x: this._selectedNode.y0,
						y: this._selectedNode.x0
					},
					target: {
						x: this._draggingNode.y0,
						y: this._draggingNode.x0
					}
				}];
			}
			var link = this._svgGroup.selectAll(".templink").data(data);

			link.enter().append("path")
				.attr("class", "templink")
				.attr("d", d3.svg.diagonal())
				.attr('pointer-events', 'none');

			link.attr("d", d3.svg.diagonal());

			link.exit().remove();
		},
		_overCircle : function(d) {
			this._selectedNode = d;
			this._updateTempConnector();
		},
		_outCircle : function(d) {
			this._selectedNode = null;
			this._updateTempConnector();
		},
		_loadTreeData : function () {

			mx.ui.action(this.nodeMicroflow,{
				params: {
					applyto: 'selection',
					guids: [this._contextObj.getGuid()]
				},
				callback:  dojoLang.hitch(this,function(result) {
					this._drawChart(result);
				}),	
				error: dojoLang.hitch(this,function(error) {
					this._hideProgress();
					console.log(error.description);
				})
			}, this);

       },
		_showProgress: function () {
			this._progressID = mx.ui.showProgress();
		},
		_hideProgress: function () {
			if (this._progressID){
				mx.ui.hideProgress(this._progressID);
				this._progressID = null;
			}
		},
		_execMF : function (d){
			// trigger the On Click Microflow. Use mx.ui.action instead of mx.data.action, since in Mx version mx.data.action has a bug in it, not able to find the mxform if a close page action is used..	
			mx.ui.action(this.onClickMF,{
						params:	{
							applyto: 'selection',
							guids: [d.guid]

						},
						progress: "modal",
						origin: this.mxform,
						error: dojoLang.hitch(this,function(error) {
							console.log(error.description);
							console.log(d.guid);
						}),
						callback: dojoLang.hitch(this,function(result){			
						})						
			},this);
		},
		_saveChanges : function(){
			
			var reference = this._parentReferenceName;	
			
			// update MxObjects based on in GUI dragged nodes
			for (var n=0 ; n < this._nodes.length ; n++){
				// only update nodes with changed parents.
				// node.parentGuid is the original parent. node.parent.guid is the new parent set after dragging 
				if (this._nodes[n].parent && this._nodes[n].parent.guid !== this._nodes[n].parentGuid){
					// get old parent MxObject based on child node
					var oldParent = this._nodeObjects.filter(dojoLang.hitch(this,function(e) {
						return e._guid == this._nodes[n].parentGuid;
					}))[0];
					// get new parent MxObject based on child node
					var newParent = this._nodeObjects.filter(dojoLang.hitch(this,function(e) {
						return e._guid == this._nodes[n].parent.guid;
					}))[0];
					// get MxObject based on child node
					var child = this._nodeObjects.filter(dojoLang.hitch(this,function(e) {
						return e._guid == this._nodes[n].guid;
					}))[0];
					
					// if parent has changed via dragging, update references of MxObjects
					
					if (oldParent && newParent && oldParent._guid !== newParent._guid){
						if (this.loggingEnabled){
							console.log("child: " + this._nodes[n].name + ", guid: " + child._guid );
							console.log("old parent: " + oldParent.jsonData.attributes.Name.value + ", guid: " + oldParent._guid);
							console.log("new parent: " + newParent.jsonData.attributes.Name.value + ", guid: " + newParent._guid);
							console.log(reference);
						}
						// remove reference to old parent 
						var removeGuidArray = [];
						removeGuidArray.push(oldParent._guid);
						// remove reference to old parent. The Client 6 API should give back a boolean whether update of references is successfull, but gives back an undefined when succesfull.
						// seems like a Mx 6.10.0 bug....
						var referenceRemoved = child.removeReferences(reference, removeGuidArray);
						// add reference to new parent
						var referenceAdded = child.addReference(reference, newParent._guid);
						// mark MxObject as updated for easier filtering in Modeler later on 
						child.set(this.updateAttr,"true");
					}
				}
			}
			// trigger the save Microflow. Use mx.ui.action instead of mx.data.action, since in Mx version mx.data.action has a bug in it, not able to find the mxform if a close page action is used..			
			mx.ui.action(this.saveMicroflow,{
						params:	{
							applyto: 'selection',
							guids: [this._contextObj.getGuid()]

						},
						progress: "modal",
						origin: this.mxform,
						error: dojoLang.hitch(this,function(error) {
							console.log(error.description);
						}),
						callback: dojoLang.hitch(this,function(result){			
						})						
			},this);
			
		},
        // mxui.widget._WidgetBase.uninitialize is called when the widget is destroyed. Implement to do special tear-down work.
        uninitialize: function() {
			// Clean up listeners, helper objects, etc. There is no need to remove listeners added with this.connect / this.subscribe / this.own.
            this._cleanUpDomNode(this.svgTree);
			if (this._progressID) {
				this._hideProgress();
			}
        },
		_cleanUpDomNode: function(node,callback) {

            while (node.firstChild ) {
               node.removeChild(node.firstChild);
            }
			if (typeof callback !== "undefined") {
              callback();
            }

        },
    });
});

require(["D3TreeView/widget/D3TreeView"], function() {
    "use strict";
});
