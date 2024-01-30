import { NestedStack, StackProps, Duration, Aws, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as imageBuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as iam from 'aws-cdk-lib/aws-iam';

interface pipelineStackProps extends StackProps {
    // ec2InstanceType: string;
}

export class PipelineStack extends NestedStack {

    _imageID;
    constructor(scope: Construct, id: string, props: pipelineStackProps) {
        super(scope, id, props);

        // Define the custom component
        const customComponent = new imageBuilder.CfnComponent(this, 'sd-custom-component', {
            name: 'sd-custom-component',
            version: '1.0.0',
            platform: 'Linux',
            data: `name: sd-custom-component
description: Stable Diffusion Custom Component
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: InstallDependencies
        action: ExecuteBash
        inputs:
          commands:
            - apt-get update
            - apt install software-properties-common -y
            - add-apt-repository ppa:deadsnakes/ppa -y
            - apt install wget git python3.10 python3.10-venv build-essential net-tools libgl1 libtcmalloc-minimal4 -y
            - update-alternatives --install /usr/bin/python3 python /usr/bin/python3.10 1

      - name: SetupStableDiffusion
        action: ExecuteBash
        inputs:
          commands:
            - cd /home/ubuntu
            - curl -sSL https://raw.githubusercontent.com/awslabs/stable-diffusion-aws-extension/main/install.sh | bash
            - cd stable-diffusion-webui/extensions/stable-diffusion-aws-extension
            - git checkout main
            - cd ../../

      - name: DownloadModels
        action: ExecuteBash
        inputs:
          commands:
            - wget -qP models/Stable-diffusion/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Stable-diffusion/sd_xl_base_1.0.safetensors
            - wget -qP models/Stable-diffusion/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors
            - wget -qP models/ControlNet/ https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_canny.pth
            - wget -qP models/ControlNet/ https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_openpose.pth
            - wget -qP models/Lora/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Lora/lcm_lora_xl.safetensors
            - wget -qP models/Lora/ https://aws-gcr-solutions-us-east-1.s3.us-east-1.amazonaws.com/extension-for-stable-diffusion-on-aws/models/Lora/lcm_lora_1_5.safetensors
            - chown -R ubuntu:ubuntu /home/ubuntu/stable-diffusion-webui

      - name: SetupService
        action: ExecuteBash
        inputs:
          commands:
            - |
              cat > sd-webui.service <<EOF
              [Unit]
              Description=Stable Diffusion UI server
              After=network.target
              StartLimitIntervalSec=0

              [Service]
              WorkingDirectory=/home/ubuntu/stable-diffusion-webui
              ExecStart=/home/ubuntu/stable-diffusion-webui/webui.sh --enable-insecure-extension-access --skip-torch-cuda-test --no-half --listen
              Type=simple
              Restart=always
              RestartSec=3
              User=ubuntu
              StartLimitAction=reboot

              [Install]
              WantedBy=default.target

              EOF
              mv sd-webui.service /etc/systemd/system
              chown root:root /etc/systemd/system/sd-webui.service
              systemctl enable sd-webui.service
              systemctl start sd-webui.service
              `,
            });

        // Define the image recipe
        const imageRecipe = new imageBuilder.CfnImageRecipe(this, 'sd-image-recipe', {
            name: 'sd-image-recipe',
            description: 'Stable Diffusion Image Recipe',
            parentImage: 'ami-0da2ab58cace8997d',
            components: [
                {
                    componentArn: customComponent.attrArn,
                },
            ],
            version: '1.0.0',
            blockDeviceMappings: [
                {
                    deviceName: '/dev/sda1',
                    ebs: {
                        volumeSize: 300,
                        volumeType: 'gp3',
                        deleteOnTermination: true,
                    },
                },
            ],
        });

        // Define the instance profile
        const role = new iam.Role(this, 'ImageBuilderRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'));

        const instanceProfile = new iam.CfnInstanceProfile(this, 'ImageBuilderInstanceProfile', {
            roles: [role.roleName],
        });

        // Define the infrastructure configuration
        const infrastructureConfiguration = new imageBuilder.CfnInfrastructureConfiguration(this, 'sd-infrastructure-configuration', {
            name: 'sd-infrastructure-configuration',
            description: 'Stable Diffusion Infrastructure Configuration',
            instanceProfileName: instanceProfile.ref,
            instanceTypes: [
                'g5.2xlarge',
                'g5.4xlarge',
            ],
            keyPair: 'us-east-1',
            terminateInstanceOnFailure: true,
            // Make the network setting alinged EC2 instance created in ec2-stack for now
            securityGroupIds: [
                'sg-07c4cfc95359ebd07',
            ],
            subnetId: 'subnet-ad9368e0',
        });

        // Define the image pipeline
        const imagePipeline = new imageBuilder.CfnImagePipeline(this, 'sd-image-pipeline', {
            name: 'sd-image-pipeline',
            description: 'Stable Diffusion Image Pipeline',
            imageRecipeArn: imageRecipe.attrArn,
            infrastructureConfigurationArn: infrastructureConfiguration.attrArn,
            status: 'ENABLED',
            // Make it run on demand for now
            schedule: {
                scheduleExpression: 'cron(0 0 * * ? *)',
            },
            // executionRole: role.roleName,
            // disable metadata collection for now
            enhancedImageMetadataEnabled: false,
        });

        // Output the image id
        const image = new imageBuilder.CfnImage(this, 'sd-image', {
            imageRecipeArn: imageRecipe.attrArn,
            infrastructureConfigurationArn: infrastructureConfiguration.attrArn,
            // imageTestsConfiguration: {
            //     imageTestsEnabled: true,
            //     timeoutMinutes: 60,
            // },
            // enhancedImageMetadataEnabled: true,
        });

        new CfnOutput(this, 'image-id', {
            value: image.attrImageId,
        });

        this._imageID = image.attrImageId;
    }
}