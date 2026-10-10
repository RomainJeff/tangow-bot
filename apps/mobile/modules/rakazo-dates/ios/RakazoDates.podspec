Pod::Spec.new do |s|
  s.name           = 'RakazoDates'
  s.version        = '0.1.0'
  s.summary        = 'Dates found in message text, added through the system calendar sheet.'
  s.description    = 'Wraps NSDataDetector and EKEventEditViewController for the Rakazo app.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
