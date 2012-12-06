imports = [
    'bootstrap'
    'deform'
    'h.controllers'
    'h.directives'
    'h.filters'
    'h.services'
]


configure = ($routeProvider, $locationProvider) ->
  $routeProvider.when '/app/viewer',
    controller: 'Viewer'
    reloadOnSearch: false
    templateUrl: 'viewer.html'
configure.$inject = ['$routeProvider', '$locationProvider']


angular.module('h', imports, configure)
